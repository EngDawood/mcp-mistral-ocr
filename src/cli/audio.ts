import { Mistral } from "@mistralai/mistralai";
import { promises as fs } from "fs";
import * as path from "path";
import { CliArgs } from "./args.js";
import { resolveApiKey, isAudioFile } from "./utils.js";

export async function transcribeAudio(
  audioPath: string,
  args: CliArgs,
  outputPath: string
): Promise<void> {
  const client = new Mistral({ apiKey: resolveApiKey(args.apiKey) });
  const fileBytes = await fs.readFile(audioPath);
  const response = await client.audio.transcriptions.complete({
    model: args.audioModel,
    file: { fileName: path.basename(audioPath), content: new Blob([fileBytes]) },
  });
  await fs.writeFile(outputPath, response.text, "utf-8");
}

export async function findFiles(
  dirPath: string,
  targetExt: string
): Promise<{ pdfs: string[]; audio: string[] }> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const pdfs: string[] = [];
  const audio: string[] = [];

  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const sub = await findFiles(full, targetExt);
      pdfs.push(...sub.pdfs);
      audio.push(...sub.audio);
    } else if (entry.isFile()) {
      if (entry.name.toLowerCase().endsWith(".pdf")) {
        const target = full.replace(/\.pdf$/i, targetExt);
        try { await fs.access(target); } catch { pdfs.push(full); }
      } else if (isAudioFile(full)) {
        const target = full.replace(/\.[^.]+$/, ".txt");
        try { await fs.access(target); } catch { audio.push(full); }
      }
    }
  }

  return { pdfs: pdfs.sort(), audio: audio.sort() };
}
