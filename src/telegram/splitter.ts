/**
 * Client for the PDF splitter container.
 *
 * Documents over Mistral's 50 MB ceiling cannot be split in the Worker: every
 * JS PDF library parses the whole file into memory and the isolate is capped at
 * 128 MB, so a 200 MB scan is not merely slow but impossible. The container has
 * real memory and real disk, so it downloads and splits, and the Worker only
 * ever streams the finished parts through to Mistral — never buffering one.
 *
 * Splitting is started and then polled rather than awaited in a single request:
 * a large download plus a qpdf pass can run for minutes, and nothing good comes
 * of holding a subrequest open that long.
 */

import { Container, getContainer } from "@cloudflare/containers";
import type { Env } from "./types.js";

export class PdfSplitter extends Container {
  defaultPort = 8080;
  /**
   * Long enough to span a slow OCR pass between two part fetches — if the
   * container sleeps mid-job the remaining parts vanish with its disk.
   * Every idle minute is billed, so this is a ceiling, not a target: the
   * session deletes the job as soon as it is done with it.
   */
  sleepAfter = "10m";
}

export interface SplitPart {
  index: number;
  /** First and last source page numbers in this part, 1-based inclusive. */
  first: number;
  last: number;
  pages: number;
  /**
   * What the part actually holds, in page-range notation ("12-30", or "1,5,90-95").
   * first..last would overstate it whenever the user asked for a non-contiguous range.
   */
  label: string;
  bytes: number;
}

export interface SplitStatus {
  state: "queued" | "downloading" | "reading" | "splitting" | "done" | "error";
  error?: string;
  downloaded?: number;
  downloadTotal?: number;
  sourceBytes?: number;
  totalPages?: number;
  selected?: number;
  missing?: number[];
  estimatedParts?: number;
  completedParts?: number;
  parts?: SplitPart[];
  /** Pages that exceed the cap even alone, so no part could contain them. */
  oversize?: number[];
}

export interface SplitRequest {
  url: string;
  /** Page spec like "1,5,10-15". Applying it here avoids splitting pages nobody asked for. */
  pages?: string;
  targetBytes?: number;
  maxPartBytes?: number;
  maxSourceBytes?: number;
}

/**
 * One container per user. The name matters beyond isolation: the public `/f/`
 * proxy has to reach the same instance the job ran on, and the name is how it
 * finds it.
 */
export function containerNameFor(userId: number | string): string {
  return `split:${userId}`;
}

function stubFor(env: Env, name: string) {
  return getContainer(env.PDF_SPLITTER, name);
}

/** A failure from the splitter container, or from the runtime in front of it. */
export class SplitterError extends Error {}

/**
 * How long to keep retrying a call the container never saw. Booting a cold
 * instance can outlast the runtime's own patience, and the job behind this is
 * a multi-minute split — waiting a few more seconds is cheaper than failing it.
 */
const CALL_RETRIES = 4;
const CALL_RETRY_MS = 3000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call the splitter, insisting on a JSON answer.
 *
 * The body is read as text first because only the *service* speaks JSON: when
 * the instance itself cannot be reached, the Workers container runtime answers
 * with a plain sentence ("Failed to start container: …"), and parsing that as
 * JSON replaced a diagnosable failure with "Unexpected token 'F'".
 *
 * A non-JSON body also means the request never reached the service, so retrying
 * it cannot duplicate a split — which is what makes riding out a cold start safe.
 */
async function call<T>(
  env: Env,
  name: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  let unreached = "";

  for (let attempt = 0; attempt <= CALL_RETRIES; attempt++) {
    const response = await stubFor(env, name).fetch(`http://splitter${path}`, init);
    const text = await response.text();

    let body: (T & { error?: string }) | undefined;
    try {
      body = JSON.parse(text) as T & { error?: string };
    } catch {
      // Not the service talking, but the runtime in front of it.
    }

    if (body === undefined) {
      unreached = `the splitter container did not answer (${response.status}: ${firstLine(text)})`;
      if (attempt < CALL_RETRIES) {
        await sleep(CALL_RETRY_MS);
        continue;
      }
      break;
    }

    if (!response.ok) {
      throw new SplitterError(body.error ?? `the splitter answered ${response.status}`);
    }
    return body;
  }

  throw new SplitterError(unreached);
}

/** One line of an error body, short enough to put in a chat message. */
function firstLine(text: string): string {
  const line = (text.trim().split("\n")[0] ?? "").trim();
  if (!line) return "empty response";
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

export async function startSplit(
  env: Env,
  name: string,
  request: SplitRequest
): Promise<string> {
  const { jobId } = await call<{ jobId: string }>(env, name, "/split", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  return jobId;
}

export function readSplitStatus(env: Env, name: string, jobId: string): Promise<SplitStatus> {
  return call<SplitStatus>(env, name, `/status/${jobId}`);
}

/** Stream one part's bytes. Used by the public proxy, so Mistral can fetch it. */
export function fetchPart(
  env: Env,
  name: string,
  jobId: string,
  index: number
): Promise<Response> {
  return stubFor(env, name).fetch(`http://splitter/part/${jobId}/${index}`);
}

/** Free the container's disk. Best-effort: a failure here must not fail the job. */
export async function discardSplit(env: Env, name: string, jobId: string): Promise<void> {
  try {
    await stubFor(env, name).fetch(`http://splitter/job/${jobId}`, { method: "DELETE" });
  } catch (e) {
    console.error("splitter cleanup failed", e);
  }
}
