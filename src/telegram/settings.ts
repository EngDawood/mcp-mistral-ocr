/**
 * Per-job settings and the user's saved defaults.
 *
 * Mirrors the CLI's priority chain (built-in defaults -> saved defaults -> per-job override),
 * but the panel produces a settings object directly: there is no argv in a chat, so `parseArgs`
 * has nothing to parse. The *shape* and the priority rule are what carry over, not the parser.
 */

export type OutputFormat = "md" | "txt";

/**
 * Image handling in markdown output.
 *
 * The CLI's default mode ("inline": OCR every embedded image as its own API call) is
 * deliberately absent. In a chat one tap of Send would fire hundreds of billed calls with no
 * visible progress, and on the Workers Free plan it exceeds the 50-subrequest cap outright.
 * That mode stays CLI-only.
 */
export type ImageMode = "drop" | "keep" | "embed";

export interface JobSettings {
  format: OutputFormat;
  images: ImageMode;
  clean: boolean;
  header: boolean;
  footer: boolean;
  /** Page spec like "1,5,10-15". Undefined means the whole document. */
  pages?: string;
}

export const DEFAULT_SETTINGS: JobSettings = {
  // Markdown by default: the result always arrives as a file, where structure is worth keeping.
  // (The CLI defaults to txt; this is a deliberate divergence for the bot.)
  format: "md",
  // Decision #10 -- see CLAUDE.telegram.md
  images: "drop",
  clean: false,
  header: true,
  footer: true,
  pages: undefined,
};

export function resolveSettings(saved?: Partial<JobSettings> | null): JobSettings {
  return { ...DEFAULT_SETTINGS, ...(saved || {}) };
}

const FORMAT_CYCLE: OutputFormat[] = ["md", "txt"];
const IMAGE_CYCLE: ImageMode[] = ["drop", "keep", "embed"];

function next<T>(cycle: T[], current: T): T {
  const i = cycle.indexOf(current);
  return cycle[(i + 1) % cycle.length];
}

/** Apply one panel button press. Returns a new settings object. */
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
    case "pages":
      // Cleared here; the router puts the user into "awaiting page spec" when it was unset.
      s.pages = undefined;
      break;
  }
  return s;
}

const IMAGE_LABEL: Record<ImageMode, string> = {
  drop: "removed",
  keep: "kept as links",
  embed: "embedded (base64)",
};

export function describe(settings: JobSettings): string {
  return [
    `Format: ${settings.format === "md" ? "Markdown" : "Plain text"}`,
    `Images: ${IMAGE_LABEL[settings.images]}`,
    `Clean repeated lines: ${settings.clean ? "on" : "off"}`,
    `Header / footer: ${settings.header ? "on" : "off"} / ${settings.footer ? "on" : "off"}`,
    `Pages: ${settings.pages ? settings.pages : "all"}`,
  ].join("\n");
}

/** Inline keyboard rows for the confirm panel. `callback_data` stays well under 64 bytes. */
export function panelKeyboard(jobId: string, settings: JobSettings) {
  const cb = (action: string) => `${action}:${jobId}`;
  return {
    inline_keyboard: [
      [
        { text: `📄 ${settings.format === "md" ? "Markdown" : "Text"}`, callback_data: cb("t.format") },
        { text: `🖼 Images: ${IMAGE_LABEL[settings.images]}`, callback_data: cb("t.images") },
      ],
      [
        { text: `🧹 Clean: ${settings.clean ? "on" : "off"}`, callback_data: cb("t.clean") },
        { text: `📑 Pages: ${settings.pages || "all"}`, callback_data: cb("t.pages") },
      ],
      [
        { text: `⬆️ Header: ${settings.header ? "on" : "off"}`, callback_data: cb("t.header") },
        { text: `⬇️ Footer: ${settings.footer ? "on" : "off"}`, callback_data: cb("t.footer") },
      ],
      [{ text: "💾 Save as my default", callback_data: cb("save") }],
      [{ text: "▶️ Send", callback_data: cb("run") }],
    ],
  };
}
