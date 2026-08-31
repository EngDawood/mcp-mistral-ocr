/**
 * Per-job settings, the user's saved defaults, and the confirm panel built from them.
 *
 * Priority chain mirrors the CLI (`src/cli/config.ts`): built-in defaults -> the user's saved
 * defaults -> per-job toggles. A job starts as a copy of the saved defaults; toggling a button
 * changes only that job. "Save as default" promotes the job's settings explicitly.
 *
 * The panel emits a settings object directly rather than reusing `parseArgs` — there is no argv
 * in a chat, so the parser would have nothing to parse. The priority rule is what carries over.
 */

import type { ImageMode, JobSettings, OutputFormat, PartsDelivery } from "./types.js";

export const DEFAULT_SETTINGS: JobSettings = {
  // Markdown by default: the result always arrives as a file, where structure is worth keeping.
  // (The CLI defaults to txt; a deliberate divergence for the bot.)
  format: "md",
  // Decision #10 in CLAUDE.telegram.md — the CLI default would fire one billed API call per
  // embedded image, invisibly, from a single tap of Send.
  images: "drop",
  clean: false,
  header: true,
  footer: true,
  // Off by default: the file is the deliverable, and an excerpt of every run
  // clutters the chat for anything longer than a page.
  preview: false,
  pages: undefined,
  // One file is what almost everyone wants; separate parts are for documents
  // big enough that a single output is unwieldy.
  parts: "merge",
};

export function resolveSettings(saved?: Partial<JobSettings> | null): JobSettings {
  return { ...DEFAULT_SETTINGS, ...(saved || {}) };
}

const FORMAT_CYCLE: OutputFormat[] = ["md", "txt"];
const IMAGE_CYCLE: ImageMode[] = ["drop", "keep", "embed"];
const PARTS_CYCLE: PartsDelivery[] = ["merge", "separate"];

function next<T>(cycle: T[], current: T): T {
  const i = cycle.indexOf(current);
  return cycle[(i + 1) % cycle.length];
}

/**
 * Apply one panel toggle, returning new settings.
 *
 * Page ranges are not toggled here — they need text input, so the router handles them
 * as their own callback action.
 */
export function applyToggle(settings: JobSettings, key: string): JobSettings {
  const s = { ...settings };
  switch (key) {
    case "format":
      s.format = next(FORMAT_CYCLE, s.format);
      break;
    case "images":
      s.images = next(IMAGE_CYCLE, s.images);
      break;
    case "clean":
      s.clean = !s.clean;
      break;
    case "header":
      s.header = !s.header;
      break;
    case "footer":
      s.footer = !s.footer;
      break;
    case "preview":
      s.preview = !s.preview;
      break;
    case "parts":
      s.parts = next(PARTS_CYCLE, s.parts);
      break;
  }
  return s;
}

const IMAGE_LABEL: Record<ImageMode, string> = {
  drop: "removed",
  keep: "kept as links",
  embed: "embedded",
};

const FORMAT_LABEL: Record<OutputFormat, string> = {
  md: "Markdown",
  txt: "Plain text",
};

const PARTS_LABEL: Record<PartsDelivery, string> = {
  merge: "one file",
  separate: "one per part",
};

/** One-line summary shown above the buttons. */
export function describeSettings(
  settings: JobSettings,
  isAudio: boolean,
  isSplit = false
): string {
  if (isAudio) {
    // Pages, images and header/footer are all meaningless for a transcript.
    return `Output: ${FORMAT_LABEL[settings.format]}${settings.preview ? " · preview on" : ""}`;
  }
  const bits = [
    `output ${FORMAT_LABEL[settings.format].toLowerCase()}`,
    `images ${IMAGE_LABEL[settings.images]}`,
    `pages ${settings.pages || "all"}`,
  ];
  if (isSplit) bits.push(`output ${PARTS_LABEL[settings.parts]}`);
  if (settings.preview) bits.push("preview on");
  if (settings.clean) bits.push("cleaned");
  if (!settings.header) bits.push("no header");
  if (!settings.footer) bits.push("no footer");
  return bits.join(" · ");
}

/**
 * Inline keyboard for the confirm panel.
 *
 * `callback_data` is capped at 64 bytes by the Bot API, so buttons carry only
 * `<action>[:<key>]:<jobId>` — every byte of real state lives in the Durable Object.
 * The router reads `parts[0]` as the action and `parts[parts.length - 1]` as the job id.
 */
export function buildPanel(
  jobId: string,
  settings: JobSettings,
  isAudio: boolean,
  isSplit = false
) {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];

  if (isAudio) {
    rows.push([
      { text: `📄 ${FORMAT_LABEL[settings.format]}`, callback_data: `t:format:${jobId}` },
    ]);
  } else {
    rows.push([
      { text: `📄 ${FORMAT_LABEL[settings.format]}`, callback_data: `t:format:${jobId}` },
      { text: `🖼 Images: ${IMAGE_LABEL[settings.images]}`, callback_data: `t:images:${jobId}` },
    ]);
    rows.push([
      { text: `📑 Pages: ${settings.pages || "all"}`, callback_data: `pages:${jobId}` },
      { text: `🧹 Clean: ${settings.clean ? "on" : "off"}`, callback_data: `t:clean:${jobId}` },
    ]);
    rows.push([
      { text: `⬆️ Header: ${settings.header ? "on" : "off"}`, callback_data: `t:header:${jobId}` },
      { text: `⬇️ Footer: ${settings.footer ? "on" : "off"}`, callback_data: `t:footer:${jobId}` },
    ]);
  }

  // Only meaningful when the document is big enough to be split in the first place.
  if (isSplit) {
    rows.push([
      {
        text: `🧩 Parts: ${PARTS_LABEL[settings.parts]}`,
        callback_data: `t:parts:${jobId}`,
      },
    ]);
  }

  rows.push([
    { text: `👁 Preview: ${settings.preview ? "on" : "off"}`, callback_data: `t:preview:${jobId}` },
  ]);

  rows.push([
    { text: "💾 Save as default", callback_data: `save:${jobId}` },
    { text: "✖️ Cancel", callback_data: `cancel:${jobId}` },
  ]);
  rows.push([{ text: "▶️ Send", callback_data: `run:${jobId}` }]);

  return { inline_keyboard: rows };
}
