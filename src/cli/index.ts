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

import { Mistral } from "@mistralai/mistralai";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import * as readline from "readline";
import { config as loadEnv } from "dotenv";

loadEnv();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const AUDIO_EXTENSIONS = new Set([
  ".mp3", ".wav", ".m4a", ".ogg", ".flac", ".opus", ".webm", ".mp4", ".mpeg",
]);

function isAudioFile(filePath: string): boolean {
  return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

interface CliArgs {
  input?: string;
  url?: string;
  model: string;
  audioModel: string;
  apiKey?: string;
  pages?: string;
  extractHeader: boolean;
  extractFooter: boolean;
  clean: boolean;
  toTxt: boolean;
  outputPath?: string;
}

// ---------------------------------------------------------------------------
// Utility: parse CLI args
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(`
Mistral OCR + Audio Transcription CLI

USAGE:
  mistral-ocr-cli <file.pdf|audio|directory>
  mistral-ocr-cli --url <pdf-url>

PDF / OCR OPTIONS:
  --md                  Output markdown (default: plain text)
  --txt                 Output plain text (explicit default)
  --pages <spec>        Pages to process, e.g. "1,8,9,11-20"
  --header <0|1>        Extract header content (default: 1)
  --footer <0|1>        Extract footer content (default: 1)
  --clean               Clean repetitive markdown headers (--md only)
  --model <name>        OCR model (default: mistral-ocr-latest)

AUDIO OPTIONS:
  --audio-model <name>  Transcription model (default: voxtral-mini-latest)
  Supported formats:    mp3 wav m4a ogg flac opus webm mp4 mpeg

SHARED OPTIONS:
  --api-key <key>       Mistral API key (overrides MISTRAL_API_KEY env)
  --output <path>       Output file path (single-file/URL mode only)
  --help, -h            Show this help message
`);
}

function parseBoolArg(value: string): boolean {
  const v = value.toLowerCase().trim();
  if (["0", "false", "no"].includes(v)) return false;
  if (["1", "true", "yes"].includes(v)) return true;
  throw new Error(`Invalid boolean value: '${value}' (expected: 0/1, false/true, no/yes)`);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    model: "mistral-ocr-latest",
    audioModel: "voxtral-mini-latest",
    extractHeader: true,
    extractFooter: true,
    clean: false,
    toTxt: true, // default is plain text
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      case "--url":
        args.url = argv[++i];
        break;
      case "--model":
        args.model = argv[++i];
        break;
      case "--audio-model":
        args.audioModel = argv[++i];
        break;
      case "--api-key":
        args.apiKey = argv[++i];
        break;
      case "--pages":
        args.pages = argv[++i];
        break;
      case "--header":
        args.extractHeader = parseBoolArg(argv[++i]);
        break;
      case "--footer":
        args.extractFooter = parseBoolArg(argv[++i]);
        break;
      case "--clean":
        args.clean = true;
        break;
      case "--md":
        args.toTxt = false;
        break;
      case "--txt":
        args.toTxt = true;
        break;
      case "--output":
        args.outputPath = argv[++i];
        break;
      default:
        if (arg.startsWith("--")) {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        }
        if (!args.input) {
          args.input = arg;
        }
    }
    i++;
  }

  return args;
}

// ---------------------------------------------------------------------------
// Utility: page spec parser
// ---------------------------------------------------------------------------

function parsePageSpec(pageSpec: string): Set<number> {
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

// ---------------------------------------------------------------------------
// Utility: markdown → plain text
// ---------------------------------------------------------------------------

function markdownToText(content: string): string {
  let text = content;
  text = text.replace(/!\[.*?\]\(.*?\)/g, "");           // drop images
  text = text.replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1");  // keep link text
  text = text.replace(/[#*_`~]+/g, "");                   // remove emphasis
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

// ---------------------------------------------------------------------------
// Utility: clean repetitive markdown (lightweight, no external dep)
// ---------------------------------------------------------------------------

function cleanMarkdown(content: string): string {
  const lines = content.split("\n");
  const counts = new Map<string, number>();
  for (const line of lines) {
    const t = line.trim();
    if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const repetitive = new Set<string>();
  for (const [line, count] of counts) {
    if (
      count >= 3 &&
      !line.match(/^Page \d+/i) &&
      !line.match(/^\[\d+\]/) &&
      !line.match(/doi:/i) &&
      !line.match(/^\d+$/)
    ) {
      repetitive.add(line);
    }
  }
  return lines
    .filter((l) => {
      const t = l.trim();
      return !t || !repetitive.has(t);
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Utility: expand ~ in paths
// ---------------------------------------------------------------------------

function expandPath(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : path.resolve(p);
}

// ---------------------------------------------------------------------------
// Utility: prompt user y/N
// ---------------------------------------------------------------------------

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(["y", "yes"].includes(answer.trim().toLowerCase()));
    });
  });
}

// ---------------------------------------------------------------------------
// Utility: find unique output path (appends _1, _2, ...)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Utility: resolve API key
// ---------------------------------------------------------------------------

function resolveApiKey(override?: string): string {
  const key = override ?? process.env.MISTRAL_API_KEY;
  if (!key) {
    throw new Error("Set MISTRAL_API_KEY in your environment or .env file, or use --api-key.");
  }
  return key;
}

// ---------------------------------------------------------------------------
// Core: transcribe audio file → .txt
// ---------------------------------------------------------------------------

async function transcribeAudio(
  audioPath: string,
  args: CliArgs,
  outputPath: string
): Promise<void> {
  const apiKey = resolveApiKey(args.apiKey);
  const client = new Mistral({ apiKey });

  const fileBytes = await fs.readFile(audioPath);
  const response = await client.audio.transcriptions.complete({
    model: args.audioModel,
    file: {
      fileName: path.basename(audioPath),
      content: new Blob([fileBytes]),
    },
  });

  await fs.writeFile(outputPath, response.text, "utf-8");
}

// ---------------------------------------------------------------------------
// Core: assemble final content from OCR response pages
// ---------------------------------------------------------------------------

function buildContent(
  pages: Array<{ markdown: string }>,
  pageNumbers: Set<number> | null,
  toTxt: boolean,
  clean: boolean,
  totalPageCount: number
): { content: string; processedCount: number; warnings: string[] } {
  const warnings: string[] = [];
  let selectedPages: string[];

  if (pageNumbers) {
    selectedPages = [];
    pages.forEach((page, idx) => {
      if (pageNumbers.has(idx + 1)) selectedPages.push(page.markdown);
    });
    const invalid = [...pageNumbers].filter((n) => n > totalPageCount);
    if (invalid.length > 0) {
      warnings.push(
        `Requested pages ${invalid.sort((a, b) => a - b).join(", ")} are out of range (PDF has ${totalPageCount} pages)`
      );
    }
  } else {
    selectedPages = pages.map((p) => p.markdown);
  }

  let markdown = selectedPages.join("\n\n");

  if (clean && !toTxt) {
    process.stderr.write("  Cleaning markdown content...\n");
    markdown = cleanMarkdown(markdown);
  }

  const content = toTxt ? markdownToText(markdown) : markdown;
  return { content, processedCount: selectedPages.length, warnings };
}

// ---------------------------------------------------------------------------
// Core: process URL (pass directly to Mistral OCR — no download)
// ---------------------------------------------------------------------------

async function processUrl(
  url: string,
  args: CliArgs,
  pageNumbers: Set<number> | null,
  outputPath: string
): Promise<{ outputPath: string; pageCount: number }> {
  const apiKey = resolveApiKey(args.apiKey);
  const client = new Mistral({ apiKey });

  const ocrParams: Record<string, unknown> = {
    document: { type: "document_url", documentUrl: url },
    model: args.model,
    includeImageBase64: false,
  };
  if (!args.extractHeader) ocrParams["extractHeader"] = false;
  if (!args.extractFooter) ocrParams["extractFooter"] = false;

  let response: Awaited<ReturnType<typeof client.ocr.process>>;
  try {
    response = await client.ocr.process(ocrParams as Parameters<typeof client.ocr.process>[0]);
  } catch (err) {
    const msg = String(err);
    if (msg.includes("extractHeader") || msg.includes("extractFooter")) {
      delete ocrParams["extractHeader"];
      delete ocrParams["extractFooter"];
      if (!args.extractHeader || !args.extractFooter) {
        process.stderr.write("  Note: Header/footer extraction control not supported by this API version\n");
      }
      response = await client.ocr.process(ocrParams as Parameters<typeof client.ocr.process>[0]);
    } else {
      throw err;
    }
  }

  const { content, processedCount, warnings } = buildContent(
    response.pages,
    pageNumbers,
    args.toTxt,
    args.clean,
    response.pages.length
  );

  for (const w of warnings) {
    process.stderr.write(`  Warning: ${w}\n`);
  }

  await fs.writeFile(outputPath, content, "utf-8");
  return { outputPath, pageCount: processedCount };
}

// ---------------------------------------------------------------------------
// Core: process local PDF (upload → signed URL → OCR)
// ---------------------------------------------------------------------------

async function processPdf(
  pdfPath: string,
  args: CliArgs,
  pageNumbers: Set<number> | null,
  outputPath: string
): Promise<{ outputPath: string; pageCount: number }> {
  const apiKey = resolveApiKey(args.apiKey);
  const client = new Mistral({ apiKey });

  const fileBytes = await fs.readFile(pdfPath);
  const uploaded = await client.files.upload({
    file: { fileName: path.basename(pdfPath), content: new Blob([fileBytes]) },
    purpose: "ocr" as Parameters<typeof client.files.upload>[0]["purpose"],
  });
  const signed = await client.files.getSignedUrl({ fileId: uploaded.id, expiry: 1 });

  const ocrParams: Record<string, unknown> = {
    document: { type: "document_url", documentUrl: signed.url },
    model: args.model,
    includeImageBase64: false,
  };
  if (!args.extractHeader) ocrParams["extractHeader"] = false;
  if (!args.extractFooter) ocrParams["extractFooter"] = false;

  let response: Awaited<ReturnType<typeof client.ocr.process>>;
  try {
    response = await client.ocr.process(ocrParams as Parameters<typeof client.ocr.process>[0]);
  } catch (err) {
    const msg = String(err);
    if (msg.includes("extractHeader") || msg.includes("extractFooter")) {
      delete ocrParams["extractHeader"];
      delete ocrParams["extractFooter"];
      if (!args.extractHeader || !args.extractFooter) {
        process.stderr.write("  Note: Header/footer extraction control not supported by this API version\n");
      }
      response = await client.ocr.process(ocrParams as Parameters<typeof client.ocr.process>[0]);
    } else {
      throw err;
    }
  }

  const { content, processedCount, warnings } = buildContent(
    response.pages,
    pageNumbers,
    args.toTxt,
    args.clean,
    response.pages.length
  );

  for (const w of warnings) {
    process.stderr.write(`  Warning: ${w}\n`);
  }

  await fs.writeFile(outputPath, content, "utf-8");
  return { outputPath, pageCount: processedCount };
}

// ---------------------------------------------------------------------------
// Core: find processable files in directory (recursive, skip already-done)
// ---------------------------------------------------------------------------

async function findFiles(
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
      const lower = entry.name.toLowerCase();
      if (lower.endsWith(".pdf")) {
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const args = parseArgs(rawArgs);

  // Validate mutually exclusive input sources
  if (!args.input && !args.url) {
    console.error("Error: Provide a file/directory path or --url.");
    printHelp();
    process.exit(1);
  }
  if (args.input && args.url) {
    console.error("Error: Provide either an input path or --url, not both.");
    process.exit(1);
  }

  // Warn about --clean with --txt
  if (args.clean && args.toTxt) {
    process.stderr.write("  Warning: --clean only works with markdown output (--md). Ignoring --clean.\n");
    args.clean = false;
  }

  // Parse pages
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
    const url = args.url;

    // Derive output filename from URL
    let filename: string;
    try {
      const u = new URL(url);
      const base = path.basename(decodeURIComponent(u.pathname));
      filename = base && base.toLowerCase().endsWith(".pdf") ? base : "downloaded_document.pdf";
    } catch {
      filename = "downloaded_document.pdf";
    }

    let outPath =
      args.outputPath ??
      path.join(process.cwd(), filename.replace(/\.pdf$/i, outputExt));

    try {
      await fs.access(outPath);
      // File exists — ask user
      const yes = await confirm(`File '${path.basename(outPath)}' already exists. Re-process? (y/N): `);
      if (!yes) {
        console.log("Skipping processing.");
        return;
      }
      outPath = await uniquePath(outPath, outputExt);
      console.log(`Output will be saved as: ${path.basename(outPath)}`);
    } catch {
      // doesn't exist, proceed
    }

    console.log(`Processing URL: ${url}`);
    const { pageCount } = await processUrl(url, args, pageNumbers, outPath);
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
      // Audio transcription
      let outPath = args.outputPath ?? inputPath.replace(/\.[^.]+$/, ".txt");

      try {
        await fs.access(outPath);
        const yes = await confirm(`File '${path.basename(outPath)}' already exists. Re-transcribe? (y/N): `);
        if (!yes) { console.log("Skipping processing."); return; }
        outPath = await uniquePath(outPath, ".txt");
        console.log(`Output will be saved as: ${path.basename(outPath)}`);
      } catch { /* doesn't exist */ }

      console.log(`Transcribing audio: ${path.basename(inputPath)}`);
      await transcribeAudio(inputPath, args, outPath);
      console.log(`  ✓ Completed: ${path.basename(outPath)}`);
      console.log(`\nProcessing complete!\nFiles processed: 1/1`);

    } else if (inputPath.toLowerCase().endsWith(".pdf")) {
      // PDF OCR
      let outPath = args.outputPath ?? inputPath.replace(/\.pdf$/i, outputExt);

      try {
        await fs.access(outPath);
        const yes = await confirm(`File '${path.basename(outPath)}' already exists. Re-process? (y/N): `);
        if (!yes) { console.log("Skipping processing."); return; }
        outPath = await uniquePath(outPath, outputExt);
        console.log(`Output will be saved as: ${path.basename(outPath)}`);
      } catch { /* doesn't exist */ }

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
