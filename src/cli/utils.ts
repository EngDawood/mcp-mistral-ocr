import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import * as readline from "readline";
import { AUDIO_EXTENSIONS, REPEAT_THRESHOLD } from "./args.js";

export function isAudioFile(filePath: string): boolean {
  return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

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
  text = text.replace(/!\[.*?\]\(.*?\)/g, "");           // drop images
  text = text.replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1");  // keep link text
  text = text.replace(/[#*_`~]+/g, "");                   // remove emphasis
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

// Removes lines that recur REPEAT_THRESHOLD+ times (page headers/footers).
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

export function expandPath(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : path.resolve(p);
}

export function resolveApiKey(override?: string): string {
  const key = override ?? process.env.MISTRAL_API_KEY;
  if (!key) {
    throw new Error("Set MISTRAL_API_KEY in your environment or .env file, or use --api-key.");
  }
  return key;
}

export async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(["y", "yes"].includes(answer.trim().toLowerCase()));
    });
  });
}

async function uniquePath(base: string, ext: string): Promise<string> {
  const stem = base.slice(0, base.length - ext.length);
  let counter = 1;
  while (true) {
    const candidate = `${stem}_${counter}${ext}`;
    try {
      await fs.access(candidate);
      counter++;
    } catch {
      return candidate;
    }
  }
}

/**
 * If outPath already exists, ask user whether to overwrite.
 * Returns the (possibly renumbered) output path, or null if the user skipped.
 */
export async function confirmOutputPath(
  outPath: string,
  ext: string,
  verb = "Re-process"
): Promise<string | null> {
  try {
    await fs.access(outPath);
  } catch {
    return outPath;
  }
  const yes = await confirm(`File '${path.basename(outPath)}' already exists. ${verb}? (y/N): `);
  if (!yes) return null;
  const unique = await uniquePath(outPath, ext);
  console.log(`Output will be saved as: ${path.basename(unique)}`);
  return unique;
}
