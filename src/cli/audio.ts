import { Mistral } from "@mistralai/mistralai";
import { promises as fs } from "fs";
import * as path from "path";
import { CliArgs } from "./args.js";
import { resolveApiKey, isAudioFile, isImageFile, isDocumentFile } from "./utils.js";

export async function transcribeAudio(
  audioPath: string,
  args: CliArgs,
  outputPath: string,
  onStep?: (msg: string) => void
): Promise<void> {
  const client = new Mistral({ apiKey: resolveApiKey(args.apiKey) });
  onStep?.("Reading audio file...");
  const fileBytes = await fs.readFile(audioPath);
  onStep?.("Transcribing...");
  const response = await client.audio.transcriptions.complete({
    model: args.audioModel,
    file: { fileName: path.basename(audioPath), content: new Blob([fileBytes]) },
  });
  onStep?.("Writing output...");
  await fs.writeFile(outputPath, response.text, "utf-8");
}

export async function findFiles(
  dirPath: string,
  targetExt: string
): Promise<{ pdfs: string[]; audio: string[]; images: string[]; markdowns: string[] }> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const pdfs: string[] = [];
  const audio: string[] = [];
  const images: string[] = [];
  const markdowns: string[] = [];

  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const sub = await findFiles(full, targetExt);
      pdfs.push(...sub.pdfs);
      audio.push(...sub.audio);
      images.push(...sub.images);
      markdowns.push(...sub.markdowns);
    } else if (entry.isFile()) {
      if (entry.name.startsWith("~$")) continue; // skip Word/Excel lock files
      if (isDocumentFile(full)) {
        const target = full.replace(/\.[^.]+$/, targetExt);
        try { await fs.access(target); } catch { pdfs.push(full); }
      } else if (isAudioFile(full)) {
        const target = full.replace(/\.[^.]+$/, ".txt");
        try { await fs.access(target); } catch { audio.push(full); }
      } else if (isImageFile(full)) {
        const target = full.replace(/\.[^.]+$/, targetExt);
        try { await fs.access(target); } catch { images.push(full); }
      } else if (entry.name.toLowerCase().endsWith(".md")) {
        const target = full.replace(/\.md$/i, ".txt");
        try { await fs.access(target); } catch { markdowns.push(full); }
      }
    }
  }

  return { pdfs: pdfs.sort(), audio: audio.sort(), images: images.sort(), markdowns: markdowns.sort() };
}
