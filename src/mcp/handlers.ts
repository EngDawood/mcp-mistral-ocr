import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import {
  ConvertInputSchema,
  TranscribeInputSchema,
  ExtractTablesInputSchema,
  CleanMarkdownInputSchema,
} from "./schemas.js";
import {
  convertBytes,
  convertUrl,
  getUsage,
  transcribe,
  type ConvertResult,
  type DoclingClient,
} from "../shared/docling.js";
import { extractHyperlinks, extractTables, finalize, parseLangs } from "../shared/convert.js";
import { normalizeSourceUrl } from "../shared/source-url.js";
import { cleanMarkdown, parsePageSpec } from "../shared/utils.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(data: object): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(error: string, suggestion?: string): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ success: false, error, ...(suggestion && { suggestion }) }, null, 2) }],
    isError: true,
  };
}

const AUDIO_MIME: Record<string, string> = {
  ".mp3": "audio/mpeg", ".mpeg": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
  ".ogg": "audio/ogg", ".opus": "audio/ogg", ".flac": "audio/flac", ".webm": "audio/webm", ".mp4": "audio/mp4",
};

function client(): DoclingClient {
  const baseUrl = process.env.DOCLING_URL;
  const apiKey = process.env.DOCLING_API_KEY;
  if (!baseUrl) throw new Error("DOCLING_URL is not set (e.g. https://docling-api.<account>.workers.dev)");
  if (!apiKey) throw new Error("DOCLING_API_KEY is not set");
  return { baseUrl, apiKey };
}

export function expandPath(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : path.resolve(p);
}

function isUrl(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

/** A name for output saved from a URL, taken from the path when it has one. */
function nameFromUrl(source: string, fallback: string): string {
  try {
    const base = path.basename(decodeURIComponent(new URL(source).pathname));
    return base ? base.replace(/\.[^.]+$/, "") || fallback : fallback;
  } catch {
    return fallback;
  }
}

function suggestionFor(message: string): string {
  if (/budget/i.test(message)) return "The monthly container budget is used up. Check docling_usage; it resets next UTC month.";
  if (/unauthorized|DOCLING_API_KEY/i.test(message)) return "Check DOCLING_API_KEY and DOCLING_URL.";
  return "Check the source is valid and DOCLING_URL is reachable.";
}

async function convertSource(
  source: string,
  opts: Parameters<typeof convertUrl>[2]
): Promise<{ result: ConvertResult; baseDir: string; baseName: string }> {
  if (isUrl(source)) {
    const { url } = normalizeSourceUrl(source);
    const result = await convertUrl(client(), url, opts);
    return { result, baseDir: process.cwd(), baseName: nameFromUrl(url, "downloaded_document") };
  }
  const filePath = expandPath(source);
  try { await fs.access(filePath); } catch { throw new Error(`File not found: ${source}`); }
  const bytes = await fs.readFile(filePath);
  const result = await convertBytes(client(), bytes, path.basename(filePath), opts);
  return { result, baseDir: path.dirname(filePath), baseName: path.basename(filePath, path.extname(filePath)) };
}

// ─── Tool 1: convert ─────────────────────────────────────────────────────────

export async function handleConvert(args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const params = ConvertInputSchema.parse(args);

    let pageNumbers: Set<number> | undefined;
    if (params.pages) {
      try { pageNumbers = parsePageSpec(params.pages); }
      catch (e: any) { return err(`Invalid page specification: ${e.message}`, "Use format like '1,5,10-15'."); }
    }

    const { result, baseDir, baseName } = await convertSource(params.source, {
      pages: pageNumbers,
      forceOcr: params.force_ocr,
      ocrLang: parseLangs(params.ocr_lang),
      images: params.images,
    });

    const { content, cleaned } = finalize(result.markdown, params.output_format, params.clean_output);

    let outputFile: string | null = null;
    if (params.save_to_file) {
      const dir = params.output_dir ? expandPath(params.output_dir) : baseDir;
      await fs.mkdir(dir, { recursive: true });
      outputFile = path.join(dir, baseName + (params.output_format === "text" ? ".txt" : ".md"));
      await fs.writeFile(outputFile, content, "utf-8");
    }

    const response: Record<string, unknown> = {
      success: true,
      content: params.return_content ? content : null,
      page_count: result.pages.length,
      pages_processed: result.pageNumbers,
      output_file: outputFile,
      format: params.output_format,
      cleaned,
      warnings: result.warnings,
    };
    if (params.include_hyperlinks) response.hyperlinks = extractHyperlinks(result.markdown);
    return ok(response);
  } catch (e: any) {
    return err(`Conversion failed: ${e.message}`, suggestionFor(e.message));
  }
}

// ─── Tool 2: transcribe ──────────────────────────────────────────────────────

export async function handleTranscribe(args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const params = TranscribeInputSchema.parse(args);

    let result;
    let baseDir = process.cwd();
    let baseName = "transcript";
    if (isUrl(params.source)) {
      result = await transcribe(client(), { url: params.source }, { language: params.language });
      baseName = nameFromUrl(params.source, baseName);
    } else {
      const filePath = expandPath(params.source);
      try { await fs.access(filePath); } catch {
        return err(`File not found: ${params.source}`, "Please provide an absolute path to an existing file.");
      }
      const ext = path.extname(filePath).toLowerCase();
      const bytes = await fs.readFile(filePath);
      result = await transcribe(
        client(),
        { bytes, contentType: AUDIO_MIME[ext] ?? "application/octet-stream" },
        { language: params.language }
      );
      baseDir = path.dirname(filePath);
      baseName = path.basename(filePath, ext);
    }

    let outputFile: string | null = null;
    if (params.save_to_file) {
      const dir = params.output_dir ? expandPath(params.output_dir) : baseDir;
      await fs.mkdir(dir, { recursive: true });
      outputFile = path.join(dir, `${baseName}.txt`);
      await fs.writeFile(outputFile, result.text, "utf-8");
    }

    return ok({
      success: true,
      content: params.return_content ? result.text : null,
      language: result.language,
      duration_seconds: result.duration,
      output_file: outputFile,
    });
  } catch (e: any) {
    return err(`Transcription failed: ${e.message}`, suggestionFor(e.message));
  }
}

// ─── Tool 3: extract tables ──────────────────────────────────────────────────

export async function handleExtractTables(args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const params = ExtractTablesInputSchema.parse(args);

    let pageNumbers: Set<number> | undefined;
    if (params.pages) {
      try { pageNumbers = parsePageSpec(params.pages); }
      catch (e: any) { return err(`Invalid page specification: ${e.message}`, "Use format like '1,5,10-15'."); }
    }

    const { result, baseDir, baseName } = await convertSource(params.source, {
      pages: pageNumbers,
      forceOcr: params.force_ocr,
      ocrLang: parseLangs(params.ocr_lang),
      images: "drop",
    });
    const tables = extractTables(result.pages, result.pageNumbers);

    let outputFile: string | null = null;
    if (params.save_to_file && tables.length > 0) {
      outputFile = path.join(baseDir, `${baseName}_tables.md`);
      await fs.writeFile(
        outputFile,
        tables.map((t) => `## Table ${t.id}${t.page ? ` (Page ${t.page})` : ""}\n\n${t.content}`).join("\n\n"),
        "utf-8"
      );
    }

    return ok({
      success: true,
      table_count: tables.length,
      page_count: result.pages.length,
      output_file: outputFile,
      format: "markdown",
      warnings: result.warnings,
      ...(params.return_content && { tables }),
    });
  } catch (e: any) {
    return err(`Table extraction failed: ${e.message}`, suggestionFor(e.message));
  }
}

// ─── Tool 4: clean markdown ──────────────────────────────────────────────────

export async function handleCleanMarkdown(args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const params = CleanMarkdownInputSchema.parse(args);
    const cleanedContent = cleanMarkdown(params.content);
    return ok({
      success: true,
      content: cleanedContent,
      original_length: params.content.length,
      cleaned_length: cleanedContent.length,
      reduction_percent: params.content.length > 0
        ? Math.round((1 - cleanedContent.length / params.content.length) * 1000) / 10
        : 0,
    });
  } catch (e: any) {
    return err(`Cleaning failed: ${e.message}`, "Ensure the content is valid markdown text.");
  }
}

// ─── Tool 5: usage ───────────────────────────────────────────────────────────

export async function handleUsage(): Promise<ToolResult> {
  try {
    const usage = await getUsage(client());
    return ok({
      success: true,
      used_hours: Math.round((usage.usedSeconds / 3600) * 100) / 100,
      limit_hours: Math.round((usage.limitSeconds / 3600) * 100) / 100,
      awake: usage.awake,
    });
  } catch (e: any) {
    return err(`Usage lookup failed: ${e.message}`, suggestionFor(e.message));
  }
}
