import { z } from "zod";

const outputFormat = z.enum(["markdown", "text"]).default("text");
const pages = z.string().optional().describe("Pages to keep, e.g. '1,5,10-15'. PDFs only.");
const forceOcr = z.boolean().default(false).describe("OCR every page even when it has a text layer.");
const ocrLang = z.string().optional().describe("OCR languages, comma separated, e.g. 'ar,en'. Default 'ar,en'.");
const images = z.enum(["drop", "keep", "embed"]).default("drop").describe(
  "drop: remove image markers. keep: leave Docling's '<!-- image -->' marker. embed: inline base64 images."
);

export const ConvertInputSchema = z.object({
  source: z.string().min(1, "Source cannot be empty").describe(
    "Path to a local file (PDF, DOCX, DOC, PPTX, XLSX, XLS, image) or an http(s) URL."
  ),
  output_format: outputFormat,
  pages,
  clean_output: z.boolean().default(false),
  force_ocr: forceOcr,
  ocr_lang: ocrLang,
  images,
  include_hyperlinks: z.boolean().default(false),
  save_to_file: z.boolean().default(true),
  output_dir: z.string().optional().describe("Where to save when the source is a URL. Default: current directory."),
  return_content: z.boolean().default(true),
});

export const TranscribeInputSchema = z.object({
  source: z.string().min(1, "Source cannot be empty").describe(
    "Path to a local audio file (mp3, wav, m4a, ogg, flac, opus, webm, mp4; up to 25 MB) or an http(s) URL."
  ),
  language: z.string().optional().describe("Spoken language code, e.g. 'ar' or 'en'. Default: auto-detect."),
  save_to_file: z.boolean().default(true),
  output_dir: z.string().optional(),
  return_content: z.boolean().default(true),
});

export const ExtractTablesInputSchema = z.object({
  source: z.string().min(1, "Source cannot be empty").describe("Local file path or http(s) URL."),
  pages,
  force_ocr: forceOcr,
  ocr_lang: ocrLang,
  save_to_file: z.boolean().default(true),
  return_content: z.boolean().default(true),
});

export const CleanMarkdownInputSchema = z.object({
  content: z.string().min(1, "Content cannot be empty"),
});

export const UsageInputSchema = z.object({});
