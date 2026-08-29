/**
 * Job execution: turn a PendingJob into text.
 *
 * Nothing here buffers the source document. Mistral is always handed a URL —
 * either the signed proxy (for Telegram files) or the user's own link — so the
 * 128 MB isolate limit is never in play regardless of document size.
 */

import { Mistral } from "@mistralai/mistralai";
import { parsePageSpec, markdownToText, cleanMarkdown } from "../shared/utils.js";
import type { JobSettings, PendingJob } from "./types.js";

const OCR_MODEL = "mistral-ocr-latest";
const AUDIO_MODEL = "voxtral-mini-latest";

/**
 * Above this, `cleanMarkdown` (which counts every line occurrence across the
 * whole document) is skipped and the user is told why.
 *
 * Note: a genuine CPU-limit kill terminates the isolate and cannot be caught,
 * so this proactive guard — not a try/catch — is what "degrade loudly" means
 * in practice.
 */
const CLEAN_CPU_GUARD_CHARS = 400_000;

export interface JobResult {
  content: string;
  pageCount: number;
  pagesProcessed: number;
  warnings: string[];
}

export type StepFn = (msg: string) => void | Promise<void>;

/** Strip every markdown image ref and collapse the blank lines left behind. */
function stripImageRefs(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * Replace `![alt](img-id)` with an inline base64 data URI.
 *
 * Deliberately reimplemented rather than imported from `src/mcp/ocr-core.ts`,
 * which pulls in `fs`, `path` and `os` and therefore cannot load in a Worker.
 */
function embedImages(markdown: string, pages: any[]): string {
  const map = new Map<string, string>();
  for (const page of pages) {
    for (const img of page.images ?? []) {
      if (img.imageBase64) {
        const uri = String(img.imageBase64).startsWith("data:")
          ? img.imageBase64
          : `data:image/png;base64,${img.imageBase64}`;
        map.set(img.id, uri);
      }
    }
  }
  if (!map.size) return markdown;
  return markdown.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (whole, alt, id) => {
    const uri = map.get(id);
    return uri ? `![${alt}](${uri})` : whole;
  });
}

function buildContent(pages: any[], settings: JobSettings): JobResult {
  const warnings: string[] = [];

  let selected: number[] | null = null;
  if (settings.pages) {
    try {
      const wanted = parsePageSpec(settings.pages);
      selected = [...wanted].filter((n) => n >= 1 && n <= pages.length);
      const missing = [...wanted].filter((n) => n < 1 || n > pages.length);
      if (missing.length) {
        warnings.push(`Document has ${pages.length} pages; skipped ${missing.join(", ")}.`);
      }
    } catch (e: any) {
      warnings.push(`Could not read page range (${e.message}); processed the whole document.`);
    }
  }

  const chosen = selected && selected.length
    ? selected.map((n) => pages[n - 1])
    : pages;

  let markdown = chosen.map((p: any) => p.markdown ?? "").join("\n\n");

  if (settings.images === "drop") {
    markdown = stripImageRefs(markdown);
  } else if (settings.images === "embed") {
    markdown = embedImages(markdown, chosen);
  }

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
    pageCount: pages.length,
    pagesProcessed: chosen.length,
    warnings,
  };
}

async function runOcr(
  client: Mistral,
  document: Record<string, unknown>,
  settings: JobSettings
): Promise<any[]> {
  const params: Record<string, unknown> = {
    document,
    model: OCR_MODEL,
    includeImageBase64: settings.images === "embed",
  };
  if (!settings.header) params.extractHeader = false;
  if (!settings.footer) params.extractFooter = false;

  try {
    const res = await client.ocr.process(params as any);
    return res.pages as any[];
  } catch (e: any) {
    // Same graceful fallback the CLI uses: some API versions reject these.
    const msg = String(e?.message ?? e);
    if (msg.includes("extractHeader") || msg.includes("extractFooter")) {
      delete params.extractHeader;
      delete params.extractFooter;
      const res = await client.ocr.process(params as any);
      return res.pages as any[];
    }
    throw e;
  }
}

/**
 * Check a user-supplied URL before spending a Mistral call on it.
 * Catches the common "share link returns an HTML interstitial" case.
 */
export async function validateUrl(
  url: string
): Promise<{ ok: true; contentType?: string; size?: number } | { ok: false; reason: string }> {
  // Links are now fetched by our own Worker (Mistral's fetcher is blocked by some
  // origins), so refuse anything pointing inward before we mint a signed token for it.
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
  } catch (e: any) {
    return { ok: false, reason: `could not reach the link (${e.message})` };
  }
  if (!res.ok) return { ok: false, reason: `the server answered ${res.status}` };

  const contentType = res.headers.get("content-type") ?? undefined;
  const lengthHeader = res.headers.get("content-length");
  const size = lengthHeader ? Number(lengthHeader) : undefined;

  if (contentType && /^text\/html/i.test(contentType)) {
    return {
      ok: false,
      reason:
        "that link returns a web page, not a file — share links from Drive and Dropbox " +
        "need their direct-download form",
    };
  }
  return { ok: true, contentType, size };
}

export async function runJob(
  job: PendingJob,
  apiKey: string,
  sourceUrl: string,
  onStep: StepFn
): Promise<JobResult> {
  const client = new Mistral({ apiKey });

  if (job.kind === "audio") {
    await onStep("Transcribing…");
    const res = await client.audio.transcriptions.complete({
      model: AUDIO_MODEL,
      fileUrl: sourceUrl,
    } as any);
    return {
      content: (res as any).text ?? "",
      pageCount: 0,
      pagesProcessed: 0,
      warnings: [],
    };
  }

  await onStep("Running OCR…");
  const document =
    job.kind === "image"
      ? { type: "image_url", imageUrl: sourceUrl }
      : { type: "document_url", documentUrl: sourceUrl };

  const pages = await runOcr(client, document, job.settings);

  await onStep("Building output…");
  return buildContent(pages, job.settings);
}

/** Turn a Mistral/plumbing error into something worth showing a chat user. */
export function explainError(e: unknown): string {
  const msg = String((e as any)?.message ?? e);

  if (/1000|too many pages|page limit/i.test(msg)) {
    return "This document is over Mistral's 1,000-page limit. Try a page range, or use the CLI.";
  }
  if (/50\s*MB|file too large|entity too large|413/i.test(msg)) {
    return "This file is over Mistral's 50 MB limit.";
  }
  if (/401|unauthor|invalid api key/i.test(msg)) {
    return "Mistral rejected the API key. Set a new one with /key.";
  }
  if (/429|rate limit/i.test(msg)) {
    return "Mistral is rate-limiting the account. Wait a moment and try again.";
  }
  if (/5\d\d|timeout|network/i.test(msg)) {
    return `Mistral had a temporary problem (${msg.slice(0, 120)}). Try again.`;
  }
  return `Failed: ${msg.slice(0, 300)}`;
}
