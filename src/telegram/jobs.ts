/**
 * Job execution: turn a PendingJob into text.
 *
 * Telegram files arrive as bytes (the Bot API caps them at 20 MB, which the
 * isolate holds comfortably); pasted links are handed to Docling as URLs so the
 * container downloads them itself and the Worker never buffers a large file.
 */

import { parsePageSpec, markdownToText, cleanMarkdown } from "../shared/utils.js";
import { filenameFromContentDisposition } from "../shared/source-url.js";
import type { SourceProvider } from "../shared/source-url.js";
import {
  convertBytes,
  convertUrl,
  transcribe,
  DoclingError,
  type ConvertResult,
  type DoclingClient,
} from "../shared/docling.js";
import type { JobSettings, PendingJob } from "./types.js";

/**
 * Above this, `cleanMarkdown` (which counts every line occurrence across the
 * whole document) is skipped and the user is told why.
 *
 * Note: a genuine CPU-limit kill terminates the isolate and cannot be caught,
 * so this proactive guard — not a try/catch — is what "degrade loudly" means
 * in practice.
 */
const CLEAN_CPU_GUARD_CHARS = 400_000;

/** An error whose message is already fit to show a chat user verbatim. */
export class UserFacingError extends Error {}

export interface JobResult {
  content: string;
  pageCount: number;
  pagesProcessed: number;
  warnings: string[];
}

export type StepFn = (msg: string) => void | Promise<void>;

function buildContent(result: ConvertResult, settings: JobSettings): JobResult {
  const warnings = [...result.warnings];
  let markdown = result.markdown;

  if (settings.clean) {
    if (markdown.length > CLEAN_CPU_GUARD_CHARS) {
      warnings.push(
        `Skipped cleaning — the document is ${Math.round(markdown.length / 1000)}k characters, ` +
        `large enough to risk the Worker CPU limit. Run it through the CLI to clean it.`
      );
    } else {
      markdown = cleanMarkdown(markdown);
    }
  }

  const content = settings.format === "txt" ? markdownToText(markdown) : markdown;
  return {
    content,
    pageCount: result.pages.length,
    pagesProcessed: result.pages.length,
    warnings,
  };
}

/**
 * Check a user-supplied URL before spending container time on it.
 * Catches the common "share link returns an HTML interstitial" case.
 */
export async function validateUrl(
  url: string,
  provider?: SourceProvider
): Promise<
  | { ok: true; contentType?: string; size?: number; fileName?: string }
  | { ok: false; reason: string }
> {
  // The container fetches the link itself, so refuse anything pointing inward first.
  try {
    const host = new URL(url).hostname.toLowerCase();
    const isPrivate =
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "0.0.0.0" ||
      host === "[::1]" ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host);
    if (isPrivate) return { ok: false, reason: "that address is not publicly reachable" };
  } catch {
    return { ok: false, reason: "that doesn't look like a valid URL" };
  }

  let res: Response;
  try {
    res = await fetch(url, { method: "HEAD", redirect: "follow" });
    // Not every origin answers HEAD honestly — some reject it outright, others
    // return a courtesy page. A one-byte ranged GET gets the real headers
    // without pulling the document down.
    if (!res.ok || /^text\/html/i.test(res.headers.get("content-type") ?? "")) {
      const ranged = await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers: { Range: "bytes=0-0" },
      });
      // Read nothing: the headers are all we came for.
      try {
        await ranged.body?.cancel();
      } catch {
        /* already consumed or unsupported */
      }
      if (ranged.ok) res = ranged;
    }
  } catch (e: any) {
    return { ok: false, reason: `could not reach the link (${e.message})` };
  }
  if (!res.ok) return { ok: false, reason: `the server answered ${res.status}` };

  const contentType = res.headers.get("content-type") ?? undefined;
  // A ranged reply reports the slice length, so the real size lives in
  // content-range ("bytes 0-0/142071") instead.
  const total = res.headers.get("content-range")?.match(/\/(\d+)\s*$/)?.[1];
  const lengthHeader = total ?? res.headers.get("content-length");
  const size = lengthHeader ? Number(lengthHeader) : undefined;
  const fileName = filenameFromContentDisposition(res.headers.get("content-disposition"));

  if (contentType && /^text\/html/i.test(contentType)) {
    // The link was already rewritten to its direct-download form before we got
    // here, so HTML now means the file isn't reachable rather than a link the
    // user needs to reshape — say that, instead of the old advice to convert it.
    if (provider === "google-drive" || provider === "google-docs") {
      return {
        ok: false,
        reason:
          "Google returned a web page instead of the file. That usually means it " +
          'isn\'t shared publicly — open it in Drive, set "Anyone with the link", ' +
          "and send it again",
      };
    }
    return {
      ok: false,
      reason:
        "that link returns a web page, not a file — check it points straight at " +
        "the document",
    };
  }
  return { ok: true, contentType, size, fileName };
}

export interface JobInput {
  client: DoclingClient;
  /** OCR languages in order of preference. */
  ocrLang: string[];
  /** Exactly one of these is set. */
  bytes?: Uint8Array;
  url?: string;
}

export async function runJob(job: PendingJob, input: JobInput, onStep: StepFn): Promise<JobResult> {
  if (job.kind === "audio") {
    await onStep("Transcribing…");
    const res = await transcribe(
      input.client,
      input.url
        ? { url: input.url }
        : { bytes: input.bytes!, contentType: audioMime(job.fileName) }
    );
    return { content: res.text, pageCount: 0, pagesProcessed: 0, warnings: [] };
  }

  const warnings: string[] = [];
  let pages: Set<number> | null = null;
  if (job.settings.pages) {
    try {
      pages = parsePageSpec(job.settings.pages);
    } catch (e: any) {
      warnings.push(`Could not read page range (${e.message}); processed the whole document.`);
    }
  }

  await onStep("Converting… (the first job after idle waits for the container to start)");
  const opts = {
    pages,
    forceOcr: job.settings.forceOcr,
    ocrLang: input.ocrLang,
    images: job.settings.images,
  };
  const result = input.url
    ? await convertUrl(input.client, input.url, opts)
    : await convertBytes(input.client, input.bytes!, job.fileName, opts);

  await onStep("Building output…");
  const built = buildContent(result, job.settings);
  built.warnings.unshift(...warnings);
  return built;
}

const AUDIO_MIME: Record<string, string> = {
  ".mp3": "audio/mpeg", ".mpeg": "audio/mpeg", ".mpga": "audio/mpeg", ".wav": "audio/wav",
  ".m4a": "audio/mp4", ".mp4": "audio/mp4", ".ogg": "audio/ogg", ".oga": "audio/ogg",
  ".opus": "audio/ogg", ".flac": "audio/flac", ".webm": "audio/webm",
};

function audioMime(fileName: string): string {
  const i = fileName.lastIndexOf(".");
  return (i >= 0 && AUDIO_MIME[fileName.slice(i).toLowerCase()]) || "application/octet-stream";
}

/** Turn a Docling/plumbing error into something worth showing a chat user. */
export function explainError(e: unknown): string {
  if (e instanceof UserFacingError) return e.message;
  const msg = String((e as any)?.message ?? e);

  if (e instanceof DoclingError) {
    if (e.status === 429) {
      return "The monthly container budget is used up, so I'm not starting new work. It resets next month.";
    }
    if (e.status === 401) return "The Docling API rejected the key. Ask the owner to update it.";
    if (e.status === 413) return "That file is too large for the Docling API.";
  }
  if (/timed out/i.test(msg)) {
    return "The conversion took too long. Try a page range, or a smaller file.";
  }
  if (/could not reach|5\d\d|network/i.test(msg)) {
    return `The Docling API had a temporary problem (${msg.slice(0, 120)}). Try again in a minute.`;
  }
  return `Failed: ${msg.slice(0, 300)}`;
}
