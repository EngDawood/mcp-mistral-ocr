/**
 * Right-to-left column ordering for OCR output.
 *
 * Mistral OCR always emits a page's text blocks left-to-right, so a
 * two-column Arabic (or Hebrew) page comes back with the *left* column first —
 * i.e. the second half of the page read before the first. Nothing in the OCR
 * request changes that, so the order is repaired here instead, using the
 * paragraph bounding boxes returned by `include_blocks: true`.
 *
 * Pure geometry and string work: no Node built-ins, so this runs in the
 * Worker and the Telegram bot as well as the CLI.
 */

/** One paragraph-level block, as returned by the OCR API (camelCase). */
export interface OcrBlock {
  topLeftX: number;
  topLeftY: number;
  bottomRightX: number;
  bottomRightY: number;
  content: string;
  /** "text" | "title" | "header" | "footer" | ... */
  type?: string | null;
}

export interface OcrPageLike {
  markdown?: string | null;
  blocks?: OcrBlock[] | null;
  dimensions?: { width?: number | null; height?: number | null } | null;
}

/** How the column order is decided. */
export type RtlMode = "auto" | "on" | "off";

/**
 * Letters written right-to-left: Hebrew, Arabic and its supplements, plus the
 * presentation forms that show up in OCR of older typesetting.
 *
 * Deliberately excludes the digits, punctuation and tatweel that share those
 * Unicode blocks — "(٣.٦٦)" is not evidence of Arabic prose, and counting it
 * as such would call a page of numeric tables right-to-left while the Latin
 * side of the comparison gets no credit for its own digits.
 */
const RTL_LETTERS =
  /[א-״ؠ-ؿف-يٮ-ٯٱ-ۓەۥ-ۦۮ-ۯۺ-ۿ܀-ݏݐ-ݿހ-ޱߊ-ߪࡰ-ࢎࢠ-ࣉיִ-ﭏﭐ-ﷇﷰ-ﷻﹰ-ﻼ]/g;
const LTR_LETTERS = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/g;

/**
 * A block this much of the page wide spans both columns (a title, a centred
 * DOI line) and separates what comes above it from what comes below.
 */
const FULL_WIDTH_RATIO = 0.55;

/**
 * A narrower block still counts as spanning if it crosses the page middle with
 * at least this much of the page on either side of it.
 */
const STRADDLE_RATIO = 0.1;

/**
 * Only blocks at least this long (after normalisation) are considered for
 * duplicate removal. Mistral sometimes repeats a whole paragraph as an extra
 * block; short blocks are left alone because a heading legitimately repeats
 * text that also appears in the body — filtering those deletes real titles.
 */
const DUPLICATE_MIN_CHARS = 100;

/** Strip markdown punctuation and Arabic diacritics so repeats compare equal. */
function normalizeForCompare(content: string): string {
  return content
    .replace(/[\s*#_>\-|]+/g, "")
    .replace(/[ً-ْـ]/g, "");
}

/**
 * Share of the letters in `text` that are written right-to-left, ignoring
 * digits, punctuation and whitespace. Returns 0 when there are no letters.
 */
export function rtlRatio(text: string): number {
  const rtl = (text.match(RTL_LETTERS) || []).length;
  const ltr = (text.match(LTR_LETTERS) || []).length;
  const total = rtl + ltr;
  return total === 0 ? 0 : rtl / total;
}

/** True when most of the letters in `text` are right-to-left. */
export function isRtlText(text: string): boolean {
  return rtlRatio(text) > 0.5;
}

/**
 * Decide the direction from the whole document rather than page by page.
 *
 * A single page is not a reliable sample: the first page of an Arabic journal
 * article carries an English abstract beside the Arabic one and can come out
 * majority-Latin, which would leave that page's columns in the wrong order
 * while the rest of the document got fixed.
 */
export function documentIsRtl(pages: OcrPageLike[]): boolean {
  return isRtlText(pages.map((p) => p.markdown ?? "").join("\n"));
}

/**
 * A page whose letters are this lopsided decides its own direction; anything
 * in between is a mixed page (Arabic and English abstracts side by side) where
 * the document's overall direction is the better guide.
 */
const PAGE_CLEARLY_LTR = 0.2;
const PAGE_CLEARLY_RTL = 0.8;

/**
 * Whether one page should be read right-to-left, given the direction of the
 * document around it.
 *
 * Documents are not uniform: an Arabic article can carry a wholly English
 * page (an English abstract, a references list), and reordering that page's
 * columns would break it just as surely as leaving the Arabic pages alone.
 */
export function pageIsRtl(pageMarkdown: string, documentRtl: boolean): boolean {
  const ratio = rtlRatio(pageMarkdown);
  if (ratio <= PAGE_CLEARLY_LTR) return false;
  if (ratio >= PAGE_CLEARLY_RTL) return true;
  return documentRtl;
}

/**
 * Put one page's blocks into right-to-left reading order.
 *
 * Header blocks stay at the top and footers at the bottom. In between, blocks
 * that span both columns act as dividers; within each band the right column is
 * read before the left, each top to bottom.
 *
 * Two columns are assumed — the layout this was built and tested for. On a
 * three-column page the middle column would be grouped with one of its
 * neighbours.
 */
export function reorderRtlBlocks(blocks: OcrBlock[], pageWidth: number): OcrBlock[] {
  const middle = pageWidth / 2;
  const centreOf = (b: OcrBlock) => (b.topLeftX + b.bottomRightX) / 2;

  const headers = blocks.filter((b) => b.type === "header");
  const footers = blocks.filter((b) => b.type === "footer");
  let body = blocks.filter((b) => b.type !== "header" && b.type !== "footer");

  // Drop paragraph-length blocks whose text is already part of a longer block.
  const normalized = body.map((b) => normalizeForCompare(b.content ?? ""));
  body = body.filter((_, i) => {
    if (normalized[i].length < DUPLICATE_MIN_CHARS) return true;
    return !normalized.some(
      (other, k) => k !== i && other.length > normalized[i].length && other.includes(normalized[i])
    );
  });

  const spansColumns = (b: OcrBlock) => {
    if (b.bottomRightX - b.topLeftX > pageWidth * FULL_WIDTH_RATIO) return true;
    const crossesMiddle = b.topLeftX < middle && b.bottomRightX > middle;
    if (!crossesMiddle) return false;
    const overhang = Math.min(middle - b.topLeftX, b.bottomRightX - middle);
    return overhang > pageWidth * STRADDLE_RATIO;
  };

  const byVerticalPosition = (a: OcrBlock, b: OcrBlock) => a.topLeftY - b.topLeftY;
  const ordered: OcrBlock[] = [];
  let band: OcrBlock[] = [];

  const flushBand = () => {
    if (band.length === 0) return;
    const right = band.filter((b) => centreOf(b) >= middle).sort(byVerticalPosition);
    const left = band.filter((b) => centreOf(b) < middle).sort(byVerticalPosition);
    ordered.push(...right, ...left);
    band = [];
  };

  for (const block of [...body].sort(byVerticalPosition)) {
    if (spansColumns(block)) {
      flushBand();
      ordered.push(block);
    } else {
      band.push(block);
    }
  }
  flushBand();

  return [...headers, ...ordered, ...footers];
}

export interface RtlLayoutResult {
  /** Page markdown in reading order — one entry per input page. */
  markdown: string[];
  /** True when at least one page was actually reordered. */
  applied: boolean;
  /** Reasons the reordering could not run, for the caller's warnings list. */
  warnings: string[];
}

/**
 * Rebuild page markdown in right-to-left reading order.
 *
 * `mode` is "auto" by default: each page is reordered only if it reads
 * right-to-left (see `pageIsRtl`), so an English page inside an Arabic
 * document keeps its natural order. "on" reorders every page (for a document
 * the letter count calls wrong), "off" disables the whole thing.
 */
export function applyRtlColumnOrder(pages: OcrPageLike[], mode: RtlMode = "auto"): RtlLayoutResult {
  const markdown = pages.map((p) => p.markdown ?? "");
  const warnings: string[] = [];

  if (mode === "off") return { markdown, applied: false, warnings };

  const documentRtl = mode === "on" || documentIsRtl(pages);
  if (!documentRtl) return { markdown, applied: false, warnings };

  let applied = false;
  let missingBlocks = false;

  const reordered = pages.map((page, i) => {
    if (mode !== "on" && !pageIsRtl(markdown[i], documentRtl)) return markdown[i];
    const blocks = page.blocks;
    const width = page.dimensions?.width;
    if (!blocks || blocks.length === 0 || !width || width <= 0) {
      missingBlocks = true;
      return markdown[i];
    }
    applied = true;
    return reorderRtlBlocks(blocks, width)
      .map((b) => b.content ?? "")
      .filter((content) => content.trim() !== "")
      .join("\n\n");
  });

  if (missingBlocks && !applied) {
    warnings.push(
      "Right-to-left column ordering was skipped: the OCR response carried no paragraph positions."
    );
  }

  return { markdown: reordered, applied, warnings };
}
