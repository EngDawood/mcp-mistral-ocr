import { z } from "zod";

export const ProcessPdfInputSchema = z.object({
  file_path: z.string().min(1, "File path cannot be empty"),
  output_format: z.enum(["markdown", "text"]).default("text"),
  pages: z.string().optional(),
  extract_header: z.boolean().default(true),
  extract_footer: z.boolean().default(true),
  clean_output: z.boolean().default(false),
  save_to_file: z.boolean().default(true),
  return_content: z.boolean().default(true),
  table_format: z.enum(["markdown", "html"]).optional(),
  include_images: z.boolean().default(false),
  include_hyperlinks: z.boolean().default(false),
});

export const ProcessUrlInputSchema = z.object({
  url: z.string().min(1, "URL cannot be empty").refine(
    (url) => url.startsWith("http://") || url.startsWith("https://"),
    "URL must start with http:// or https://"
  ),
  output_format: z.enum(["markdown", "text"]).default("text"),
  pages: z.string().optional(),
  extract_header: z.boolean().default(true),
  extract_footer: z.boolean().default(true),
  clean_output: z.boolean().default(false),
  keep_pdf: z.boolean().default(false),
  output_dir: z.string().optional(),
  return_content: z.boolean().default(true),
  table_format: z.enum(["markdown", "html"]).optional(),
  include_images: z.boolean().default(false),
  include_hyperlinks: z.boolean().default(false),
});

export const ProcessImageInputSchema = z.object({
  image_source: z.string().min(1, "Image source cannot be empty"),
  source_type: z.enum(["url", "file", "base64"]).default("url"),
  output_format: z.enum(["markdown", "text"]).default("text"),
  clean_output: z.boolean().default(false),
  save_to_file: z.boolean().default(true),
  return_content: z.boolean().default(true),
});

export const ExtractStructuredInputSchema = z.object({
  file_path: z.string().min(1, "File path cannot be empty"),
  json_schema: z.string().min(1, "JSON schema cannot be empty"),
  pages: z.string().optional(),
  annotation_type: z.enum(["document", "bbox"]).default("document"),
  include_images: z.boolean().default(false),
});

export const ExtractTablesInputSchema = z.object({
  file_path: z.string().min(1, "File path cannot be empty"),
  table_format: z.enum(["markdown", "html"]).default("html"),
  pages: z.string().optional(),
  save_to_file: z.boolean().default(true),
  return_content: z.boolean().default(true),
});

export const CleanMarkdownInputSchema = z.object({
  content: z.string().min(1, "Content cannot be empty"),
  config_path: z.string().optional(),
});

export interface OcrResult {
  markdown_content: string;
  total_pages: number;
  pages_processed: number[];
  warnings: string[];
  tables?: any[];
  images?: any[];
  hyperlinks?: any[];
}
