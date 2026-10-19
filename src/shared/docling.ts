/**
 * Client for the docling-api Worker (https://github.com/EngDawood/docling).
 *
 * Conversion goes through docling-serve's asynchronous endpoints: submit, poll,
 * fetch. The synchronous endpoint gives up after 120 s by default, and a cold
 * container needs a good part of that just to load its models.
 *
 * Files are sent inline as base64 `file_sources` rather than as multipart form
 * fields. That keeps one request shape for URLs and files, and lets `page_range`
 * travel as a real JSON array instead of a repeated form field.
 *
 * Works in Node 18+ and in Workers: it only uses fetch and the global
 * Uint8Array/btoa.
 */

export interface DoclingClient {
  baseUrl: string;
  apiKey: string;
}

export class DoclingError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "DoclingError";
  }
}

export type ImageMode = "drop" | "keep" | "embed";

export interface ConvertOptions {
  /** 1-based page numbers to keep. Null/undefined means the whole document. */
  pages?: Set<number> | null;
  forceOcr?: boolean;
  /** BCP-47 tags in order of preference, e.g. ["ar", "en"]. */
  ocrLang?: string[];
  /** drop: remove image markers. keep: leave docling's `<!-- image -->` marker. embed: inline base64. */
  images?: ImageMode;
  /** Give up waiting after this long. Default 15 minutes. */
  timeoutMs?: number;
  onStatus?: (message: string) => void;
}

export interface ConvertResult {
  markdown: string;
  /** Markdown of each returned page, in order. */
  pages: string[];
  /** Source page number of each entry in `pages`. */
  pageNumbers: number[];
  warnings: string[];
  processingTime?: number;
}

export interface TranscribeResult {
  text: string;
  vtt: string;
  segments: { start: number; end: number; text: string }[];
  language?: string;
  duration?: number;
}

export interface Usage {
  usedSeconds: number;
  limitSeconds: number;
  awake: boolean;
}

const PAGE_BREAK = "<!--docling-page-break-->";
const IMAGE_MARKER = /^[ \t]*<!--\s*image\s*-->[ \t]*\r?\n?/gm;

// A cold container can outlast the runtime's patience before it answers at all.
// Those failures arrive as 5xx before the service has seen the request, so
// retrying the submit cannot create a duplicate job.
const START_RETRIES = 5;
const START_RETRY_MS = 4000;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function base64(bytes: Uint8Array): string {
  const nodeBuffer = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer;
  if (nodeBuffer) return nodeBuffer.from(bytes).toString("base64");
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function headers(client: DoclingClient, extra?: Record<string, string>): Record<string, string> {
  return { "X-Api-Key": client.apiKey, ...extra };
}

function url(client: DoclingClient, path: string): string {
  return `${client.baseUrl.replace(/\/+$/, "")}${path}`;
}

/** The server's own explanation if it gave one, else the status line. */
async function failure(response: Response): Promise<DoclingError> {
  const text = await response.text();
  let message = text.trim().split("\n")[0] ?? "";
  try {
    const body = JSON.parse(text) as { error?: string; detail?: unknown };
    if (body.error) message = body.error;
    else if (typeof body.detail === "string") message = body.detail;
    else if (body.detail !== undefined) message = JSON.stringify(body.detail);
  } catch {
    // Not JSON: the runtime in front of the service answered in prose.
  }
  if (response.status === 401) message = "Unauthorized: check DOCLING_API_KEY";
  return new DoclingError(message || `HTTP ${response.status}`, response.status);
}

async function send(client: DoclingClient, path: string, init: RequestInit, retry: boolean): Promise<Response> {
  const attempts = retry ? START_RETRIES : 0;
  for (let attempt = 0; ; attempt++) {
    let error: DoclingError;
    try {
      const response = await fetch(url(client, path), init);
      if (response.ok) return response;
      error = await failure(response);
    } catch (err) {
      error = new DoclingError(`could not reach ${client.baseUrl}: ${(err as Error).message}`);
    }
    // No status means the network failed; 5xx means the runtime answered for a
    // container that is not up yet. Anything else is the service's own verdict.
    const transient = error.status === undefined || error.status >= 500;
    if (!retry || !transient || attempt >= attempts) throw error;
    await sleep(START_RETRY_MS);
  }
}

function buildOptions(opts: ConvertOptions): Record<string, unknown> {
  const options: Record<string, unknown> = {
    to_formats: ["md"],
    do_ocr: true,
    image_export_mode: opts.images === "embed" ? "embedded" : "placeholder",
    // Cropping every picture is wasted work unless the pixels end up in the output.
    include_images: opts.images === "embed",
    md_page_break_placeholder: PAGE_BREAK,
  };
  if (opts.forceOcr) options.force_ocr = true;
  if (opts.ocrLang?.length) options.ocr_lang = opts.ocrLang;
  if (opts.pages && opts.pages.size > 0) {
    const numbers = [...opts.pages];
    options.page_range = [Math.min(...numbers), Math.max(...numbers)];
  }
  return options;
}

interface TaskState {
  task_id: string;
  task_status: "pending" | "started" | "success" | "failure";
  task_position?: number;
}

async function runTask(
  client: DoclingClient,
  body: Record<string, unknown>,
  opts: ConvertOptions
): Promise<{ md: string; processingTime?: number; errors: string[] }> {
  opts.onStatus?.("Submitting (the first request after idle waits for the container to start)...");
  const submitted = await send(
    client,
    "/v1/convert/source/async",
    { method: "POST", headers: headers(client, { "content-type": "application/json" }), body: JSON.stringify(body) },
    true
  );
  let task = (await submitted.json()) as TaskState;

  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let delay = 2000;
  let lastStatus = "";
  while (task.task_status !== "success" && task.task_status !== "failure") {
    if (Date.now() > deadline) throw new DoclingError("timed out waiting for the conversion");
    await sleep(delay);
    delay = Math.min(delay + 1000, 5000);
    const polled = await send(client, `/v1/status/poll/${task.task_id}`, { headers: headers(client) }, true);
    task = (await polled.json()) as TaskState;
    const status =
      task.task_status === "pending" && task.task_position
        ? `Queued (position ${task.task_position})...`
        : task.task_status === "started"
          ? "Converting..."
          : "";
    if (status && status !== lastStatus) {
      lastStatus = status;
      opts.onStatus?.(status);
    }
  }

  // A failed task still has a result body that says why.
  const result = await fetch(url(client, `/v1/result/${task.task_id}`), { headers: headers(client) });
  if (!result.ok) throw await failure(result);
  const payload = (await result.json()) as {
    document?: { md_content?: string | null };
    status?: string;
    processing_time?: number;
    errors?: { error_message?: string; message?: string }[];
  };
  const errors = (payload.errors ?? []).map((e) => e.error_message ?? e.message ?? JSON.stringify(e));

  if (task.task_status === "failure" || payload.status === "failure") {
    throw new DoclingError(errors[0] ?? "conversion failed");
  }
  return { md: payload.document?.md_content ?? "", processingTime: payload.processing_time, errors };
}

function shape(md: string, opts: ConvertOptions, processingTime: number | undefined, errors: string[]): ConvertResult {
  const warnings = [...errors];
  const raw = md.split(PAGE_BREAK);
  const first = opts.pages && opts.pages.size > 0 ? Math.min(...opts.pages) : 1;

  let pages = raw;
  let pageNumbers = raw.map((_, i) => first + i);

  if (opts.pages && opts.pages.size > 0) {
    const keep = pageNumbers.map((n) => opts.pages!.has(n));
    pages = raw.filter((_, i) => keep[i]);
    pageNumbers = pageNumbers.filter((_, i) => keep[i]);
    const missing = [...opts.pages].filter((n) => !pageNumbers.includes(n)).sort((a, b) => a - b);
    if (missing.length > 0) {
      warnings.push(`Requested pages ${missing.join(", ")} are out of range or were not returned`);
    }
  }

  if (opts.images === "drop" || opts.images === undefined) {
    pages = pages.map((p) => p.replace(IMAGE_MARKER, "").replace(/\n{3,}/g, "\n\n"));
  }
  pages = pages.map((p) => p.trim());

  return { markdown: pages.join("\n\n"), pages, pageNumbers, warnings, processingTime };
}

/** Convert a document at a public URL. */
export async function convertUrl(client: DoclingClient, sourceUrl: string, opts: ConvertOptions = {}): Promise<ConvertResult> {
  const { md, processingTime, errors } = await runTask(
    client,
    { options: buildOptions(opts), http_sources: [{ url: sourceUrl }] },
    opts
  );
  return shape(md, opts, processingTime, errors);
}

/** Convert a document held in memory. `filename` matters: docling infers the type from its extension. */
export async function convertBytes(
  client: DoclingClient,
  bytes: Uint8Array,
  filename: string,
  opts: ConvertOptions = {}
): Promise<ConvertResult> {
  const { md, processingTime, errors } = await runTask(
    client,
    { options: buildOptions(opts), file_sources: [{ base64_string: base64(bytes), filename }] },
    opts
  );
  return shape(md, opts, processingTime, errors);
}

/** Transcribe audio on Workers AI (does not touch the container). */
export async function transcribe(
  client: DoclingClient,
  source: { bytes: Uint8Array; contentType?: string } | { url: string },
  opts: { language?: string } = {}
): Promise<TranscribeResult> {
  const query = opts.language ? `?language=${encodeURIComponent(opts.language)}` : "";
  const init: RequestInit =
    "url" in source
      ? {
          method: "POST",
          headers: headers(client, { "content-type": "application/json" }),
          body: JSON.stringify({ url: source.url }),
        }
      : {
          method: "POST",
          headers: headers(client, { "content-type": source.contentType ?? "application/octet-stream" }),
          // Uint8Array is a valid fetch body in Node and Workers; the DOM and Workers
          // typings disagree about the buffer type, so cast rather than copy.
          body: source.bytes as unknown as BodyInit,
        };
  const response = await send(client, `/v1/transcribe${query}`, init, false);
  return (await response.json()) as TranscribeResult;
}

export async function getUsage(client: DoclingClient): Promise<Usage> {
  const response = await send(client, "/v1/usage", { headers: headers(client) }, false);
  return (await response.json()) as Usage;
}
