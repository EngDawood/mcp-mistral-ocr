/**
 * Post-processing for Docling output, shared by the MCP servers and the bot.
 * Runtime-agnostic: no Node built-ins, so it loads in a Worker too.
 */

import { cleanMarkdown, markdownToText } from "./utils.js";

export type OutputFormat = "markdown" | "text";

export const DEFAULT_OCR_LANG = "ar,en";

export function parseLangs(value: string | undefined): string[] {
  return (value ?? DEFAULT_OCR_LANG)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function finalize(
  markdown: string,
  format: OutputFormat,
  clean: boolean
): { content: string; cleaned: boolean } {
  const cleaned = clean && format === "markdown";
  const source = cleaned ? cleanMarkdown(markdown) : markdown;
  return { content: format === "text" ? markdownToText(source) : source, cleaned };
}

export interface Hyperlink {
  text: string;
  url: string;
}

/** Inline links only; image refs (`![alt](src)`) are not hyperlinks. */
export function extractHyperlinks(markdown: string): Hyperlink[] {
  const links: Hyperlink[] = [];
  const pattern = /(?<!!)\[([^\]]+)\]\(([^)\s]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    links.push({ text: match[1], url: match[2] });
  }
  return links;
}

export interface Table {
  /** 1-based, in document order. */
  id: number;
  /** Source page, when the converter reported page boundaries. */
  page?: number;
  /** The table as a markdown pipe table. */
  content: string;
}

const SEPARATOR_ROW = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;

function isTableLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("|") && t.endsWith("|") && t.length > 1;
}

/** Find the pipe tables in each page's markdown. A table needs a header separator row. */
export function extractTables(pages: string[], pageNumbers: number[]): Table[] {
  const tables: Table[] = [];
  pages.forEach((markdown, p) => {
    const lines = markdown.split("\n");
    let i = 0;
    while (i < lines.length) {
      if (!isTableLine(lines[i])) {
        i++;
        continue;
      }
      let end = i;
      while (end < lines.length && isTableLine(lines[end])) end++;
      const block = lines.slice(i, end);
      if (block.length >= 2 && block.some((l) => SEPARATOR_ROW.test(l.trim()))) {
        tables.push({ id: tables.length + 1, page: pageNumbers[p], content: block.join("\n") });
      }
      i = end;
    }
  });
  return tables;
}
