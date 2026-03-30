import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import * as readline from "readline";
import { AUDIO_EXTENSIONS } from "./args.js";
import { parsePageSpec, markdownToText, cleanMarkdown } from "../shared/utils.js";

export { parsePageSpec, markdownToText, cleanMarkdown };

export function isAudioFile(filePath: string): boolean {
  return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
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
