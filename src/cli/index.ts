#!/usr/bin/env node
/**
 * Mistral OCR + Audio Transcription CLI
 *
 * USAGE:
 *   mistral-ocr-cli <file.pdf|audio|directory>   # process local file or directory
 *   mistral-ocr-cli --url <url>                  # process PDF from URL directly
 *
 * OPTIONS (PDF / OCR):
 *   --md                  Output markdown (default: plain text)
 *   --txt                 Output plain text (default)
 *   --pages <spec>        Page selection, e.g. "1,8,9,11-20"
 *   --header <0|1>        Extract header (default: 1)
 *   --footer <0|1>        Extract footer (default: 1)
 *   --clean               Clean repetitive markdown headers (only with --md)
 *   --model <name>        OCR model (default: mistral-ocr-latest)
 *
 * OPTIONS (Audio transcription):
 *   --audio-model <name>  Transcription model (default: voxtral-mini-latest)
 *                         Supported audio: mp3 wav m4a ogg flac opus webm mp4
 *
 * SHARED OPTIONS:
 *   --api-key <key>       Mistral API key (overrides MISTRAL_API_KEY env var)
 *   --output <path>       Output file path (single-file/URL mode only)
 *   --help, -h            Show this help
 */

import { promises as fs } from "fs";
import * as path from "path";
import { config as loadEnv } from "dotenv";
import { parseArgs, printHelp } from "./args.js";
import { isAudioFile, expandPath, confirmOutputPath, parsePageSpec } from "./utils.js";
import { processUrl, processPdf } from "./ocr.js";
import { transcribeAudio, findFiles } from "./audio.js";

loadEnv();

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.input && !args.url) {
    console.error("Error: Provide a file/directory path or --url.");
    printHelp();
    process.exit(1);
  }
  if (args.input && args.url) {
    console.error("Error: Provide either an input path or --url, not both.");
    process.exit(1);
  }

  if (args.clean && args.toTxt) {
    process.stderr.write("  Warning: --clean only works with markdown output (--md). Ignoring --clean.\n");
    args.clean = false;
  }

  let pageNumbers: Set<number> | null = null;
  if (args.pages) {
    try {
      pageNumbers = parsePageSpec(args.pages);
      console.log(`Processing pages: ${[...pageNumbers].sort((a, b) => a - b).join(", ")}`);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  const outputExt = args.toTxt ? ".txt" : ".md";

  // ── URL mode ──────────────────────────────────────────────────────────────
  if (args.url) {
    let filename: string;
    try {
      const u = new URL(args.url);
      const base = path.basename(decodeURIComponent(u.pathname));
      filename = base && base.toLowerCase().endsWith(".pdf") ? base : "downloaded_document.pdf";
    } catch {
      filename = "downloaded_document.pdf";
    }

    const defaultOut = path.join(process.cwd(), filename.replace(/\.pdf$/i, outputExt));
    const outPath = await confirmOutputPath(args.outputPath ?? defaultOut, outputExt);
    if (!outPath) { console.log("Skipping processing."); return; }

    console.log(`Processing URL: ${args.url}`);
    const { pageCount } = await processUrl(args.url, args, pageNumbers, outPath);
    console.log(`  ✓ Completed: ${path.basename(outPath)} (${pageCount} pages)`);
    console.log(`\nProcessing complete!\nFiles processed: 1/1`);
    return;
  }

  // ── Local file / directory mode ───────────────────────────────────────────
  const inputPath = expandPath(args.input!);

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(inputPath);
  } catch {
    console.error(`Error: Path not found: ${inputPath}`);
    process.exit(1);
  }

  if (stat.isFile()) {
    // ── Single file ──────────────────────────────────────────────────────────
    if (isAudioFile(inputPath)) {
      const defaultOut = inputPath.replace(/\.[^.]+$/, ".txt");
      const outPath = await confirmOutputPath(args.outputPath ?? defaultOut, ".txt", "Re-transcribe");
      if (!outPath) { console.log("Skipping processing."); return; }

      console.log(`Transcribing audio: ${path.basename(inputPath)}`);
      await transcribeAudio(inputPath, args, outPath);
      console.log(`  ✓ Completed: ${path.basename(outPath)}`);
      console.log(`\nProcessing complete!\nFiles processed: 1/1`);

    } else if (inputPath.toLowerCase().endsWith(".pdf")) {
      const defaultOut = inputPath.replace(/\.pdf$/i, outputExt);
      const outPath = await confirmOutputPath(args.outputPath ?? defaultOut, outputExt);
      if (!outPath) { console.log("Skipping processing."); return; }

      console.log(`Processing 1 PDF file...`);
      console.log(`Processing: ${path.basename(inputPath)}`);
      const { pageCount } = await processPdf(inputPath, args, pageNumbers, outPath);
      console.log(`  ✓ Completed: ${path.basename(outPath)} (${pageCount} pages)`);
      console.log(`\nProcessing complete!\nFiles processed: 1/1`);

    } else {
      console.error(
        `Error: Unsupported file type: ${path.basename(inputPath)}\n` +
        `Supported: PDF files and audio (mp3 wav m4a ogg flac opus webm mp4 mpeg)`
      );
      process.exit(1);
    }

  } else if (stat.isDirectory()) {
    // ── Directory mode ────────────────────────────────────────────────────────
    const { pdfs, audio } = await findFiles(inputPath, outputExt);
    const total = pdfs.length + audio.length;

    if (total === 0) {
      console.log(`Nothing to process — all files already have output files.`);
      return;
    }

    console.log(`Processing ${total} file(s) from directory...`);
    let processed = 0;

    for (const pdfFile of pdfs) {
      const outPath = pdfFile.replace(/\.pdf$/i, outputExt);
      console.log(`Processing: ${path.basename(pdfFile)}`);
      try {
        const { pageCount } = await processPdf(pdfFile, args, pageNumbers, outPath);
        processed++;
        console.log(`  ✓ Completed: ${path.basename(outPath)} (${pageCount} pages)`);
      } catch (err) {
        process.stderr.write(`  ✗ Error: ${path.basename(pdfFile)}: ${(err as Error).message}\n`);
      }
    }

    for (const audioFile of audio) {
      const outPath = audioFile.replace(/\.[^.]+$/, ".txt");
      console.log(`Transcribing: ${path.basename(audioFile)}`);
      try {
        await transcribeAudio(audioFile, args, outPath);
        processed++;
        console.log(`  ✓ Completed: ${path.basename(outPath)}`);
      } catch (err) {
        process.stderr.write(`  ✗ Error: ${path.basename(audioFile)}: ${(err as Error).message}\n`);
      }
    }

    console.log(`\nProcessing complete!\nFiles processed: ${processed}/${total}`);
  } else {
    console.error(`Error: Path is neither a file nor a directory: ${inputPath}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
