import { promises as fs } from "fs";
import * as path from "path";
import { CliArgs } from "./args.js";
import { resolveClient, markdownToText, cleanMarkdown } from "./utils.js";
import { normalizeSourceUrl } from "../shared/source-url.js";
import {
  convertBytes,
  convertUrl,
  type ConvertOptions,
  type ConvertResult,
  type ImageMode,
} from "../shared/docling.js";

/** --drop-imgs wins over --embed-imgs, which wins over --imgs; with none of them images are dropped. */
function imageMode(args: CliArgs): ImageMode {
  if (args.dropImgs) return "drop";
  if (args.embedImgs) return "embed";
  if (args.keepImgs) return "keep";
  return "drop";
}

function convertOptions(
  args: CliArgs,
  pageNumbers: Set<number> | null,
  onStep?: (msg: string) => void
): ConvertOptions {
  return {
    pages: pageNumbers,
    forceOcr: args.forceOcr,
    ocrLang: args.ocrLang,
    images: imageMode(args),
    onStatus: onStep,
  };
}

async function writeResult(
  result: ConvertResult,
  args: CliArgs,
  outputPath: string,
  onStep?: (msg: string) => void
): Promise<{ outputPath: string; pageCount: number }> {
  for (const w of result.warnings) process.stderr.write(`  Warning: ${w}\n`);

  let markdown = result.markdown;
  if (args.clean && !args.toTxt) {
    process.stderr.write("  Cleaning markdown content...\n");
    markdown = cleanMarkdown(markdown);
  }

  const content = args.toTxt ? markdownToText(markdown) : markdown;
  onStep?.("Writing output...");
  await fs.writeFile(outputPath, content, "utf-8");
  return { outputPath, pageCount: result.pages.length };
}

/** Convert a document or image on disk. */
export async function processFile(
  filePath: string,
  args: CliArgs,
  pageNumbers: Set<number> | null,
  outputPath: string,
  onStep?: (msg: string) => void
): Promise<{ outputPath: string; pageCount: number }> {
  const client = resolveClient(args);
  const ext = path.extname(filePath).toLowerCase();

  // Only PDFs have pages Docling can address; for the rest the range would
  // either be ignored or rejected, and silently ignoring it hides the mistake.
  let pages = pageNumbers;
  if (pages && ext !== ".pdf") {
    process.stderr.write(`  Warning: --pages only applies to PDFs; converting the whole ${ext || "file"}\n`);
    pages = null;
  }

  onStep?.("Reading file...");
  const bytes = await fs.readFile(filePath);
  const result = await convertBytes(client, bytes, path.basename(filePath), convertOptions(args, pages, onStep));
  return writeResult(result, args, outputPath, onStep);
}

export async function processUrl(
  url: string,
  args: CliArgs,
  pageNumbers: Set<number> | null,
  outputPath: string,
  onStep?: (msg: string) => void
): Promise<{ outputPath: string; pageCount: number }> {
  const client = resolveClient(args);
  // Drive/Docs/Dropbox/GitHub links point at a viewer page; Docling needs the file.
  const { url: sourceUrl } = normalizeSourceUrl(url);
  const result = await convertUrl(client, sourceUrl, convertOptions(args, pageNumbers, onStep));
  return writeResult(result, args, outputPath, onStep);
}
