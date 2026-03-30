/**
 * Pure utility functions shared across MCP server, Cloudflare Worker, and CLI.
 * No Node.js built-ins (fs, path, os) — runtime-agnostic.
 */

const REPEAT_THRESHOLD = 3;

export function parsePageSpec(pageSpec: string): Set<number> {
  const pages = new Set<number>();
  for (const part of pageSpec.split(",")) {
    const trimmed = part.trim();
    if (trimmed.includes("-")) {
      if (trimmed.startsWith("-")) {
        throw new Error(`Page numbers must be positive (got '${trimmed}')`);
      }
      const [a, b] = trimmed.split("-");
      const start = parseInt(a.trim(), 10);
      const end = parseInt(b.trim(), 10);
      if (isNaN(start) || isNaN(end)) {
        throw new Error(`Invalid page range: '${trimmed}'`);
      }
      if (start < 1 || end < 1) {
        throw new Error(`Page numbers must be positive (got ${start}-${end})`);
      }
      if (start > end) {
        throw new Error(`Invalid page range: ${start}-${end} (start must be <= end)`);
      }
      for (let n = start; n <= end; n++) pages.add(n);
    } else {
      const num = parseInt(trimmed, 10);
      if (isNaN(num) || num < 1) {
        throw new Error(`Invalid page number: '${trimmed}'`);
      }
      pages.add(num);
    }
  }
  return pages;
}

export function markdownToText(content: string): string {
  let text = content;
  text = text.replace(/!\[.*?\]\(.*?\)/g, "");
  text = text.replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1");
  text = text.replace(/[#*_`~]+/g, "");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

// Removes lines appearing REPEAT_THRESHOLD+ times (page headers/footers).
// Preserves page numbers, footnotes, DOIs, and standalone digits.
export function cleanMarkdown(content: string): string {
  const lines = content.split("\n");
  const trimmed = lines.map((l) => l.trim());
  const counts = new Map<string, number>();
  for (const t of trimmed) {
    if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const repetitive = new Set<string>();
  for (const [line, count] of counts) {
    if (
      count >= REPEAT_THRESHOLD &&
      !line.match(/^Page \d+/i) &&
      !line.match(/^\[\d+\]/) &&
      !line.match(/doi:/i) &&
      !line.match(/^\d+$/)
    ) {
      repetitive.add(line);
    }
  }
  return lines.filter((_, i) => !trimmed[i] || !repetitive.has(trimmed[i])).join("\n");
}

export function buildSchemaFromJson(jsonSchema: string): Record<string, any> {
  try {
    const schema = JSON.parse(jsonSchema);
    if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
      throw new Error("Schema must be a JSON object");
    }
    return schema;
  } catch (e: any) {
    throw new Error(`Invalid JSON schema: ${e.message}`);
  }
}
