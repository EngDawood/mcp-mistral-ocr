#!/usr/bin/env node

import { promises as fs } from "fs";
import * as path from "path";
import { config as loadEnv } from "dotenv";
import { parseArgs, printHelp } from "./args.js";
import { isAudioFile, isImageFile, isDocumentFile, expandPath, confirmOutputPath, parsePageSpec, markdownToText, Spinner } from "./utils.js";
import { processUrl, processPdf, processDocx, processImage } from "./ocr.js";
import { transcribeAudio, findFiles } from "./audio.js";
import {
  DEFAULT_CONFIG_PATH,
  DEFAULT_DOWNLOAD_DIR,
  loadConfig,
  resolveConfig,
  runConfigCommand,
  type FileTypeKey,
  type CliConfig,
} from "./config.js";

loadEnv();

function getFileType(filePath: string): FileTypeKey | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".pdf" || ext === ".pptx" || ext === ".xlsx" || ext === ".xls") return "pdf";
  if (ext === ".docx" || ext === ".doc") return "docx";
  if (isImageFile(filePath)) return "img";
  if (isAudioFile(filePath)) return "audio";
  return null;
}

function buildArgs(argv: string[], config: CliConfig, type?: FileTypeKey) {
  return parseArgs(argv, resolveConfig(config, type));
}

function resolveUrlSaveDir(config: CliConfig): string {
  if (!config.allowedDirs) return process.cwd();
  const cwd = path.resolve(process.cwd());
  const allowed = config.allowedDirs.split(",").map(d => path.resolve(expandPath(d.trim())));
  const inAllowed = allowed.some(d => cwd === d || cwd.startsWith(d + path.sep));
  return inAllowed ? cwd : (config.downloadDir ? expandPath(config.downloadDir) : DEFAULT_DOWNLOAD_DIR);
}

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);

  // ── Pre-scan for --config <path>, stripping it from the args ──────────────
  // It must be removed here: the `config` subcommand parser has no notion of
  // flags, so a leftover `--config <path>` would be read as its command name.
  let configPath = DEFAULT_CONFIG_PATH;
  const argv: string[] = [];
  for (let i = 0; i < rawArgv.length; i++) {
    if (rawArgv[i] !== "--config") { argv.push(rawArgv[i]); continue; }
    const value = rawArgv[++i];
    if (value === undefined) {
      console.error("Error: --config requires a path.");
      process.exit(1);
    }
    configPath = expandPath(value);
  }

  // ── config subcommand ─────────────────────────────────────────────────────
  if (argv[0] === "config") {
    await runConfigCommand(argv.slice(1), configPath);
    return;
  }

  // ── Load config ───────────────────────────────────────────────────────────
  const config = await loadConfig(configPath);

  // ── Parse args with global config as defaults ─────────────────────────────
  const args = buildArgs(argv, config);

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
    process.stderr.write("  Warning: --clean only works with --md output. Ignoring --clean.\n");
    args.clean = false;
  }

  if (args.dropImgs && (args.keepImgs || args.embedImgs)) {
    process.stderr.write("  Warning: --drop-imgs takes precedence over --imgs/--embed-imgs. Images will be removed.\n");
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

  // ── URL mode ──────────────────────────────────────────────────────────────
  if (args.url) {
    // URLs are treated as PDF type for config resolution
    const urlArgs = buildArgs(argv, config, "pdf");
    const outputExt = urlArgs.toTxt ? ".txt" : ".md";

    let filename: string;
    try {
      const u = new URL(args.url);
      const base = path.basename(decodeURIComponent(u.pathname));
      filename = base ? base.replace(/\.[^.]+$/, "") + outputExt : `downloaded_document${outputExt}`;
    } catch {
      filename = `downloaded_document${outputExt}`;
    }

    const saveDir = resolveUrlSaveDir(config);
    const defaultOut = path.join(saveDir, filename);
    const outPath = await confirmOutputPath(args.outputPath ?? defaultOut, outputExt);
    if (!outPath) { console.log("Skipping processing."); return; }

    console.log(`Processing URL: ${args.url}`);
    const spinner = new Spinner();
    try {
      const { pageCount } = await processUrl(args.url, urlArgs, pageNumbers, outPath, (msg) => spinner.update(msg));
      spinner.succeed(`${path.basename(outPath)} (${pageCount} pages)`);
    } catch (err) {
      spinner.fail((err as Error).message);
      process.exit(1);
    }
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
    // ── Single file — re-parse with type-specific config ──────────────────
    const fileType = getFileType(inputPath);
    const tArgs = fileType ? buildArgs(argv, config, fileType) : args;
    const outputExt = tArgs.toTxt ? ".txt" : ".md";

    if (isAudioFile(inputPath)) {
      const defaultOut = inputPath.replace(/\.[^.]+$/, ".txt");
      const outPath = await confirmOutputPath(tArgs.outputPath ?? defaultOut, ".txt", "Re-transcribe");
      if (!outPath) { console.log("Skipping processing."); return; }

      console.log(`Transcribing audio: ${path.basename(inputPath)}`);
      const spinner = new Spinner();
      try {
        await transcribeAudio(inputPath, tArgs, outPath, (msg) => spinner.update(msg));
        spinner.succeed(path.basename(outPath));
      } catch (err) {
        spinner.fail((err as Error).message);
        process.exit(1);
      }
      console.log(`\nProcessing complete!\nFiles processed: 1/1`);

    } else if (isDocumentFile(inputPath)) {
      const defaultOut = inputPath.replace(/\.[^.]+$/, outputExt);
      const outPath = await confirmOutputPath(tArgs.outputPath ?? defaultOut, outputExt);
      if (!outPath) { console.log("Skipping processing."); return; }

      console.log(`Processing: ${path.basename(inputPath)}`);
      const ext = path.extname(inputPath).toLowerCase();
      const useDocx = (ext === ".docx" || ext === ".doc") && !tArgs.forceOcr;
      const spinner = new Spinner();
      const onStep = (msg: string) => spinner.update(msg);
      try {
        const { pageCount } = useDocx
          ? await processDocx(inputPath, tArgs, outPath, onStep)
          : await processPdf(inputPath, tArgs, pageNumbers, outPath, onStep);
        spinner.succeed(`${path.basename(outPath)} (${pageCount} pages)`);
      } catch (err) {
        spinner.fail((err as Error).message);
        process.exit(1);
      }
      console.log(`\nProcessing complete!\nFiles processed: 1/1`);

    } else if (isImageFile(inputPath)) {
      const defaultOut = inputPath.replace(/\.[^.]+$/, outputExt);
      const outPath = await confirmOutputPath(tArgs.outputPath ?? defaultOut, outputExt);
      if (!outPath) { console.log("Skipping processing."); return; }

      console.log(`Processing image: ${path.basename(inputPath)}`);
      const spinner = new Spinner();
      try {
        await processImage(inputPath, tArgs, outPath, (msg) => spinner.update(msg));
        spinner.succeed(path.basename(outPath));
      } catch (err) {
        spinner.fail((err as Error).message);
        process.exit(1);
      }
      console.log(`\nProcessing complete!\nFiles processed: 1/1`);

    } else if (inputPath.toLowerCase().endsWith(".md")) {
      const defaultOut = inputPath.replace(/\.md$/i, ".txt");
      const outPath = await confirmOutputPath(tArgs.outputPath ?? defaultOut, ".txt", "Re-convert");
      if (!outPath) { console.log("Skipping processing."); return; }

      console.log(`Converting markdown to text: ${path.basename(inputPath)}`);
      const mdContent = await fs.readFile(inputPath, "utf-8");
      await fs.writeFile(outPath, markdownToText(mdContent), "utf-8");
      console.log(`  ✓ Completed: ${path.basename(outPath)}`);
      console.log(`\nProcessing complete!\nFiles processed: 1/1`);

    } else {
      console.error(
        `Error: Unsupported file type: ${path.extname(inputPath) || path.basename(inputPath)}\n` +
        `Supported: PDF/DOCX/DOC/PPTX/XLSX/XLS, images (jpg jpeg png gif webp bmp tiff), markdown (.md), audio (mp3 wav m4a ogg flac opus webm mp4 mpeg)`
      );
      process.exit(1);
    }

  } else if (stat.isDirectory()) {
    // ── Directory mode — build type-specific args for each batch ─────────
    const pdfArgs   = buildArgs(argv, config, "pdf");
    const docxArgs  = buildArgs(argv, config, "docx");
    const imgArgs   = buildArgs(argv, config, "img");
    const audioArgs = buildArgs(argv, config, "audio");

    const pdfExt   = pdfArgs.toTxt  ? ".txt" : ".md";
    const docxExt  = docxArgs.toTxt ? ".txt" : ".md";
    const imgExt   = imgArgs.toTxt  ? ".txt" : ".md";

    // findFiles uses global output ext for the "already done?" check
    const globalExt = args.toTxt ? ".txt" : ".md";
    const { pdfs: allPdfs, audio: allAudio, images: allImages, markdowns } = await findFiles(inputPath, globalExt);

    const skipNonAudio = args.audioOnly;
    const skipNonMd    = args.mdOnly;
    const pdfs        = (skipNonAudio || skipNonMd) ? [] : allPdfs.filter(f => !f.toLowerCase().endsWith(".docx") && !f.toLowerCase().endsWith(".doc"));
    const docxFiles   = (skipNonAudio || skipNonMd) ? [] : allPdfs.filter(f => f.toLowerCase().endsWith(".docx") || f.toLowerCase().endsWith(".doc"));
    const audio       = (skipNonMd) ? [] : allAudio;
    const images      = (skipNonAudio || skipNonMd) ? [] : allImages;
    const activeMarkdowns = (skipNonAudio || !args.toTxt) ? [] : markdowns;
    const total = pdfs.length + docxFiles.length + audio.length + images.length + activeMarkdowns.length;

    if (total === 0) {
      console.log(`Nothing to process — all files already have output files.`);
      return;
    }

    console.log(`Processing ${total} file(s) from directory...`);
    let processed = 0;

    for (const pdfFile of pdfs) {
      const outPath = pdfFile.replace(/\.[^.]+$/, pdfExt);
      console.log(`Processing: ${path.basename(pdfFile)}`);
      try {
        const { pageCount } = await processPdf(pdfFile, pdfArgs, pageNumbers, outPath);
        processed++;
        console.log(`  ✓ Completed: ${path.basename(outPath)} (${pageCount} pages)`);
      } catch (err) {
        process.stderr.write(`  ✗ Error: ${path.basename(pdfFile)}: ${(err as Error).message}\n`);
      }
    }

    for (const docxFile of docxFiles) {
      const outPath = docxFile.replace(/\.[^.]+$/, docxExt);
      console.log(`Processing: ${path.basename(docxFile)}`);
      try {
        const useDocx = !docxArgs.forceOcr;
        const { pageCount } = useDocx
          ? await processDocx(docxFile, docxArgs, outPath)
          : await processPdf(docxFile, docxArgs, pageNumbers, outPath);
        processed++;
        console.log(`  ✓ Completed: ${path.basename(outPath)} (${pageCount} pages)`);
      } catch (err) {
        process.stderr.write(`  ✗ Error: ${path.basename(docxFile)}: ${(err as Error).message}\n`);
      }
    }

    for (const imageFile of images) {
      const outPath = imageFile.replace(/\.[^.]+$/, imgExt);
      console.log(`Processing image: ${path.basename(imageFile)}`);
      try {
        await processImage(imageFile, imgArgs, outPath);
        processed++;
        console.log(`  ✓ Completed: ${path.basename(outPath)}`);
      } catch (err) {
        process.stderr.write(`  ✗ Error: ${path.basename(imageFile)}: ${(err as Error).message}\n`);
      }
    }

    for (const audioFile of audio) {
      const outPath = audioFile.replace(/\.[^.]+$/, ".txt");
      console.log(`Transcribing: ${path.basename(audioFile)}`);
      try {
        await transcribeAudio(audioFile, audioArgs, outPath);
        processed++;
        console.log(`  ✓ Completed: ${path.basename(outPath)}`);
      } catch (err) {
        process.stderr.write(`  ✗ Error: ${path.basename(audioFile)}: ${(err as Error).message}\n`);
      }
    }

    for (const mdFile of activeMarkdowns) {
      const outPath = mdFile.replace(/\.md$/i, ".txt");
      console.log(`Converting: ${path.basename(mdFile)}`);
      try {
        const mdContent = await fs.readFile(mdFile, "utf-8");
        await fs.writeFile(outPath, markdownToText(mdContent), "utf-8");
        processed++;
        console.log(`  ✓ Completed: ${path.basename(outPath)}`);
      } catch (err) {
        process.stderr.write(`  ✗ Error: ${path.basename(mdFile)}: ${(err as Error).message}\n`);
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
