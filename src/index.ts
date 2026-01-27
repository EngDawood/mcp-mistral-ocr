#!/usr/bin/env node
/**
 * MCP Server for PDF OCR using Mistral AI.
 *
 * TypeScript port of mistral_ocr_mcp.py
 *
 * Tools:
 * - mistral_ocr_process_pdf: Process a local PDF file
 * - mistral_ocr_process_url: Download and process PDF from URL
 * - mistral_ocr_process_image: Process image file directly
 * - mistral_ocr_extract_structured: Extract structured data with JSON schema
 * - mistral_ocr_extract_tables: Extract tables in HTML/markdown format
 * - mistral_ocr_clean_markdown: Clean repetitive content from markdown
 *
 * Configuration:
 *   Set MISTRAL_API_KEY environment variable or use .env file.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Mistral } from "@mistralai/mistralai";
import { z } from "zod";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import { config } from "dotenv";

// Load environment variables
config();

// Constants
const DEFAULT_MODEL = "mistral-ocr-latest";

// =============================================================================
// Zod Input Schemas
// =============================================================================

const ProcessPdfInputSchema = z.object({
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

const ProcessUrlInputSchema = z.object({
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

const ProcessImageInputSchema = z.object({
  image_source: z.string().min(1, "Image source cannot be empty"),
  source_type: z.enum(["url", "file", "base64"]).default("url"),
  output_format: z.enum(["markdown", "text"]).default("text"),
  clean_output: z.boolean().default(false),
  save_to_file: z.boolean().default(true),
  return_content: z.boolean().default(true),
});

const ExtractStructuredInputSchema = z.object({
  file_path: z.string().min(1, "File path cannot be empty"),
  json_schema: z.string().min(1, "JSON schema cannot be empty"),
  pages: z.string().optional(),
  annotation_type: z.enum(["document", "bbox"]).default("document"),
  include_images: z.boolean().default(false),
});

const ExtractTablesInputSchema = z.object({
  file_path: z.string().min(1, "File path cannot be empty"),
  table_format: z.enum(["markdown", "html"]).default("html"),
  pages: z.string().optional(),
  save_to_file: z.boolean().default(true),
  return_content: z.boolean().default(true),
});

const CleanMarkdownInputSchema = z.object({
  content: z.string().min(1, "Content cannot be empty"),
  config_path: z.string().optional(),
});

// =============================================================================
// Utility Functions
// =============================================================================

function parsePageSpec(pageSpec: string): Set<number> {
  const pages = new Set<number>();
  const parts = pageSpec.split(",");

  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.includes("-")) {
      if (trimmed.startsWith("-")) {
        throw new Error(`Page numbers must be positive (got '${trimmed}')`);
      }
      const rangeParts = trimmed.split("-");
      if (rangeParts.length !== 2) {
        throw new Error(
          `Invalid page range format: '${trimmed}' (expected format: '11-20')`
        );
      }
      const start = parseInt(rangeParts[0].trim(), 10);
      const end = parseInt(rangeParts[1].trim(), 10);
      if (start < 1 || end < 1) {
        throw new Error(`Page numbers must be positive (got ${start}-${end})`);
      }
      if (start > end) {
        throw new Error(
          `Invalid page range: ${start}-${end} (start must be <= end)`
        );
      }
      for (let i = start; i <= end; i++) {
        pages.add(i);
      }
    } else {
      const pageNum = parseInt(trimmed, 10);
      if (pageNum < 1) {
        throw new Error(`Page numbers must be positive (got ${pageNum})`);
      }
      pages.add(pageNum);
    }
  }

  return pages;
}

function markdownToText(content: string): string {
  let text = content;
  // Drop images
  text = text.replace(/!\[.*?\]\(.*?\)/g, "");
  // Keep link text
  text = text.replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1");
  // Remove emphasis markers
  text = text.replace(/[#*_`~]+/g, "");
  // Normalize multiple newlines
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function cleanMarkdownContent(content: string): [string, string] {
  // Lightweight inline implementation (no npm equivalent of Python markdowncleaner)
  // Remove lines that appear 3+ times (likely headers/footers)
  const lines = content.split("\n");
  const lineCounts = new Map<string, number>();

  // Count occurrences of each non-empty line
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      lineCounts.set(trimmed, (lineCounts.get(trimmed) || 0) + 1);
    }
  }

  // Identify repetitive lines (appearing 3+ times)
  const repetitiveLines = new Set<string>();
  for (const [line, count] of lineCounts.entries()) {
    if (count >= 3) {
      // Preserve page numbers, footnotes, DOIs
      if (
        !line.match(/^Page \d+/i) &&
        !line.match(/^\[\d+\]/) &&
        !line.match(/doi:/i) &&
        !line.match(/^\d+$/)
      ) {
        repetitiveLines.add(line);
      }
    }
  }

  // Filter out repetitive lines
  const cleanedLines = lines.filter((line) => {
    const trimmed = line.trim();
    return trimmed.length === 0 || !repetitiveLines.has(trimmed);
  });

  const cleanedContent = cleanedLines.join("\n");
  return [cleanedContent, "lightweight inline deduplication"];
}

async function downloadPdfFromUrl(
  url: string,
  outputDir?: string
): Promise<string> {
  const urlObj = new URL(url);
  let filename = path.basename(urlObj.pathname);

  if (!filename || !filename.toLowerCase().endsWith(".pdf")) {
    filename = "downloaded_document.pdf";
  }

  const dir = outputDir || os.tmpdir();
  const outputPath = path.join(dir, filename);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  await fs.writeFile(outputPath, Buffer.from(buffer));

  return outputPath;
}

function getApiKey(): string {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    throw new Error(
      "MISTRAL_API_KEY not found. " +
        "Set it as an environment variable or in a .env file."
    );
  }
  return apiKey;
}

function encodeImageToBase64(imagePath: string): string {
  const ext = path.extname(imagePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
  };
  const mimeType = mimeTypes[ext] || "image/png";

  const imageData = require("fs").readFileSync(imagePath);
  const encoded = Buffer.from(imageData).toString("base64");
  return `data:${mimeType};base64,${encoded}`;
}

function buildSchemaFromJson(jsonSchema: string): Record<string, any> {
  try {
    const schema = JSON.parse(jsonSchema);
    if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
      throw new Error("Schema must be a JSON object");
    }
    return schema;
  } catch (e: any) {
    throw new Error(`Invalid JSON schema: ${e.message}`);
  }
}

async function processImageOcr(
  imageSource: string,
  sourceType: string,
  model: string = DEFAULT_MODEL
): Promise<[string, string[]]> {
  const apiKey = getApiKey();
  const client = new Mistral({ apiKey });
  const warnings: string[] = [];

  let imageUrl: string;
  if (sourceType === "url") {
    imageUrl = imageSource;
  } else if (sourceType === "file") {
    const imagePath = expandPath(imageSource);
    try {
      await fs.access(imagePath);
    } catch {
      throw new Error(`Image file not found: ${imageSource}`);
    }
    imageUrl = encodeImageToBase64(imagePath);
  } else if (sourceType === "base64") {
    if (!imageSource.startsWith("data:")) {
      imageUrl = `data:image/png;base64,${imageSource}`;
    } else {
      imageUrl = imageSource;
    }
  } else {
    throw new Error(`Invalid source_type: ${sourceType}`);
  }

  const response = await client.ocr.process({
    document: { type: "image_url", imageUrl },
    model,
    includeImageBase64: false,
  });

  const markdownPages = response.pages.map((page: any) => page.markdown);
  const markdownContent = markdownPages.join("\n\n");

  return [markdownContent, warnings];
}

function extractTablesFromPages(pages: any[], tableFormat: string): any[] {
  const tables: any[] = [];
  let tableId = 0;

  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const page = pages[pageIdx];
    if (!page.tables || page.tables.length === 0) {
      continue;
    }

    for (const table of page.tables) {
      let tableContent = (table as any)[tableFormat];
      if (tableContent === undefined || tableContent === null) {
        tableContent = table.markdown || String(table);
      }

      tables.push({
        id: `tbl-${tableId}`,
        page: pageIdx + 1,
        content: tableContent,
        format: tableFormat,
      });
      tableId++;
    }
  }

  return tables;
}

function extractImagesFromPages(pages: any[]): any[] {
  const images: any[] = [];
  let imageId = 0;

  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const page = pages[pageIdx];
    if (!page.images || page.images.length === 0) {
      continue;
    }

    for (const img of page.images) {
      const imageInfo: any = {
        id: `img-${imageId}`,
        page: pageIdx + 1,
      };

      if (img.topLeftX !== undefined) {
        imageInfo.bbox = {
          top_left_x: img.topLeftX || 0,
          top_left_y: img.topLeftY || 0,
          bottom_right_x: img.bottomRightX || 0,
          bottom_right_y: img.bottomRightY || 0,
        };
      }

      if (img.imageBase64 !== undefined) {
        imageInfo.has_base64 = Boolean(img.imageBase64);
      }

      images.push(imageInfo);
      imageId++;
    }
  }

  return images;
}

function extractHyperlinksFromContent(markdownContent: string): any[] {
  const pattern = /\[([^\]]+)\]\(([^\)]+)\)/g;
  const hyperlinks: any[] = [];
  let match;

  while ((match = pattern.exec(markdownContent)) !== null) {
    const [, text, url] = match;
    // Skip image links
    if (
      url.startsWith("data:image") ||
      [".png", ".jpg", ".jpeg", ".gif", ".webp"].some((ext) =>
        url.toLowerCase().endsWith(ext)
      )
    ) {
      continue;
    }
    hyperlinks.push({ text, url });
  }

  return hyperlinks;
}

function expandPath(filePath: string): string {
  if (filePath.startsWith("~")) {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return path.resolve(filePath);
}

interface OcrResult {
  markdown_content: string;
  total_pages: number;
  pages_processed: number[];
  warnings: string[];
  tables?: any[];
  images?: any[];
  hyperlinks?: any[];
}

async function processPdfOcr(
  pdfPath: string,
  model: string = DEFAULT_MODEL,
  pageNumbers?: Set<number>,
  extractHeader: boolean = true,
  extractFooter: boolean = true,
  tableFormat?: string,
  includeImages: boolean = false,
  includeHyperlinks: boolean = false
): Promise<OcrResult> {
  const apiKey = getApiKey();
  const client = new Mistral({ apiKey });

  // Upload file
  const fileBytes = await fs.readFile(pdfPath);
  const blob = new Blob([fileBytes]);

  const uploaded = await client.files.upload({
    file: blob as any,
    purpose: "ocr",
  });

  const signedUrlResponse = await client.files.getSignedUrl({
    fileId: uploaded.id!,
  });

  // Build OCR request parameters
  let ocrParams: any = {
    document: { type: "document_url", documentUrl: signedUrlResponse.url },
    model,
    includeImageBase64: includeImages,
  };

  if (!extractHeader) {
    ocrParams.extractHeader = false;
  }
  if (!extractFooter) {
    ocrParams.extractFooter = false;
  }

  // Process OCR
  let response;
  try {
    response = await client.ocr.process(ocrParams);
  } catch (e: any) {
    // If extract_header/extract_footer not supported, retry without them
    if (
      e.message &&
      (e.message.includes("extractHeader") || e.message.includes("extractFooter"))
    ) {
      ocrParams = {
        document: { type: "document_url", documentUrl: signedUrlResponse.url },
        model,
        includeImageBase64: includeImages,
      };
      response = await client.ocr.process(ocrParams);
    } else {
      throw e;
    }
  }

  const warnings: string[] = [];
  const totalPages = response.pages.length;

  // Determine which pages to process
  let markdownPages: string[];
  let pageObjects: any[];
  let pagesProcessed: number[];

  if (pageNumbers) {
    const filteredPages: string[] = [];
    const filteredPageObjects: any[] = [];
    const processedList: number[] = [];

    for (let idx = 0; idx < response.pages.length; idx++) {
      const pageNum = idx + 1;
      if (pageNumbers.has(pageNum)) {
        filteredPages.push(response.pages[idx].markdown);
        filteredPageObjects.push(response.pages[idx]);
        processedList.push(pageNum);
      }
    }

    // Check for invalid pages
    const allPages = new Set<number>();
    for (let i = 1; i <= totalPages; i++) {
      allPages.add(i);
    }
    const invalidPages = Array.from(pageNumbers).filter((p) => !allPages.has(p));
    if (invalidPages.length > 0) {
      warnings.push(
        `Requested pages ${invalidPages.sort((a, b) => a - b).join(", ")} are out of range (PDF has ${totalPages} pages)`
      );
    }

    markdownPages = filteredPages;
    pageObjects = filteredPageObjects;
    pagesProcessed = processedList;
  } else {
    markdownPages = response.pages.map((page: any) => page.markdown);
    pageObjects = Array.from(response.pages);
    pagesProcessed = Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  const markdownContent = markdownPages.join("\n\n");

  // Build result
  const result: OcrResult = {
    markdown_content: markdownContent,
    total_pages: totalPages,
    pages_processed: pagesProcessed,
    warnings,
  };

  // Extract tables if requested
  if (tableFormat) {
    result.tables = extractTablesFromPages(pageObjects, tableFormat);
  }

  // Extract images if requested
  if (includeImages) {
    result.images = extractImagesFromPages(pageObjects);
  }

  // Extract hyperlinks if requested
  if (includeHyperlinks) {
    result.hyperlinks = extractHyperlinksFromContent(markdownContent);
  }

  return result;
}

// =============================================================================
// MCP Server Setup
// =============================================================================

const server = new Server(
  {
    name: "mistral_ocr_mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "mistral_ocr_process_pdf",
        description:
          "Process a local PDF file and extract text or markdown using Mistral OCR. " +
          "This tool uploads a PDF to Mistral's OCR service and extracts the content " +
          "as either markdown (preserving formatting, tables, headings) or plain text.",
        inputSchema: {
          type: "object",
          properties: {
            file_path: {
              type: "string",
              description: "Absolute path to the PDF file to process",
            },
            output_format: {
              type: "string",
              enum: ["markdown", "text"],
              default: "text",
              description:
                "Output format: 'markdown' preserves formatting, 'text' is plain text",
            },
            pages: {
              type: "string",
              description:
                "Specific pages to process (e.g., '1,8,9,11-20'). If not specified, all pages are processed",
            },
            extract_header: {
              type: "boolean",
              default: true,
              description: "Extract header content from PDF pages",
            },
            extract_footer: {
              type: "boolean",
              default: true,
              description: "Extract footer content from PDF pages",
            },
            clean_output: {
              type: "boolean",
              default: false,
              description:
                "Clean repetitive headers/footers from markdown output (only applies to markdown format)",
            },
            save_to_file: {
              type: "boolean",
              default: true,
              description:
                "Save output to file alongside the PDF. If false, only returns content",
            },
            return_content: {
              type: "boolean",
              default: true,
              description:
                "Return full content in JSON response. If False, only file path is returned (useful for large PDFs)",
            },
            table_format: {
              type: "string",
              enum: ["markdown", "html"],
              description:
                "Extract tables in specified format. If None, tables are included in main content",
            },
            include_images: {
              type: "boolean",
              default: false,
              description:
                "Include image metadata in response (bounding boxes, dimensions)",
            },
            include_hyperlinks: {
              type: "boolean",
              default: false,
              description: "Extract and include hyperlinks from the document",
            },
          },
          required: ["file_path"],
        },
        annotations: {
          title: "Process PDF with OCR",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: "mistral_ocr_process_url",
        description:
          "Download a PDF from a URL and extract text or markdown using Mistral OCR. " +
          "This tool downloads a PDF from the specified URL, processes it with OCR, " +
          "and optionally saves the output. The downloaded PDF can be kept or deleted.",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "URL of the PDF file to download and process",
            },
            output_format: {
              type: "string",
              enum: ["markdown", "text"],
              default: "text",
              description: "Output format: 'markdown' or 'text'",
            },
            pages: {
              type: "string",
              description: "Specific pages to process (e.g., '1,8,9,11-20')",
            },
            extract_header: {
              type: "boolean",
              default: true,
              description: "Extract header content from PDF pages",
            },
            extract_footer: {
              type: "boolean",
              default: true,
              description: "Extract footer content from PDF pages",
            },
            clean_output: {
              type: "boolean",
              default: false,
              description: "Clean repetitive content from markdown output",
            },
            keep_pdf: {
              type: "boolean",
              default: false,
              description: "Keep the downloaded PDF file after processing",
            },
            output_dir: {
              type: "string",
              description:
                "Directory to save output files. Defaults to current working directory",
            },
            return_content: {
              type: "boolean",
              default: true,
              description:
                "Return full content in JSON response. If False, only file path is returned (useful for large PDFs)",
            },
            table_format: {
              type: "string",
              enum: ["markdown", "html"],
              description:
                "Extract tables in specified format. If None, tables are included in main content",
            },
            include_images: {
              type: "boolean",
              default: false,
              description:
                "Include image metadata in response (bounding boxes, dimensions)",
            },
            include_hyperlinks: {
              type: "boolean",
              default: false,
              description: "Extract and include hyperlinks from the document",
            },
          },
          required: ["url"],
        },
        annotations: {
          title: "Process PDF from URL",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: "mistral_ocr_process_image",
        description:
          "Process an image file and extract text or markdown using Mistral OCR. " +
          "This tool processes images (PNG, JPG, etc.) directly without requiring " +
          "PDF conversion. Supports URLs, local files, and base64-encoded data.",
        inputSchema: {
          type: "object",
          properties: {
            image_source: {
              type: "string",
              description:
                "Image source: URL, local file path, or base64-encoded string",
            },
            source_type: {
              type: "string",
              enum: ["url", "file", "base64"],
              default: "url",
              description:
                "Type of image source: 'url' for web URLs, 'file' for local paths, 'base64' for encoded data",
            },
            output_format: {
              type: "string",
              enum: ["markdown", "text"],
              default: "text",
              description:
                "Output format: 'markdown' preserves formatting, 'text' is plain text",
            },
            clean_output: {
              type: "boolean",
              default: false,
              description: "Clean repetitive content from markdown output",
            },
            save_to_file: {
              type: "boolean",
              default: true,
              description:
                "Save output to file. For URL/base64 sources, saves to current directory",
            },
            return_content: {
              type: "boolean",
              default: true,
              description: "Return full content in JSON response",
            },
          },
          required: ["image_source"],
        },
        annotations: {
          title: "Process Image with OCR",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: "mistral_ocr_extract_structured",
        description:
          "Extract structured data from PDF or image using a JSON schema. " +
          "This tool uses Mistral's document annotation feature to extract " +
          "structured data matching a provided JSON schema. Useful for " +
          "extracting specific fields like names, dates, amounts, etc. " +
          "Note: Document annotation is limited to 8 pages maximum.",
        inputSchema: {
          type: "object",
          properties: {
            file_path: {
              type: "string",
              description: "Absolute path to PDF or image file",
            },
            json_schema: {
              type: "string",
              description:
                "JSON schema as string defining the structure to extract",
            },
            pages: {
              type: "string",
              description:
                "Specific pages to process (e.g., '1,5-8'). Limited to 8 pages for document annotation",
            },
            annotation_type: {
              type: "string",
              enum: ["document", "bbox"],
              default: "document",
              description:
                "Annotation type: 'document' for document-level, 'bbox' for bounding box annotations",
            },
            include_images: {
              type: "boolean",
              default: false,
              description: "Include base64-encoded images in response",
            },
          },
          required: ["file_path", "json_schema"],
        },
        annotations: {
          title: "Extract Structured Data",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: "mistral_ocr_extract_tables",
        description:
          "Extract tables from PDF in HTML or markdown format. " +
          "This tool focuses specifically on table extraction from PDFs, " +
          "returning tables in a structured format suitable for further processing.",
        inputSchema: {
          type: "object",
          properties: {
            file_path: {
              type: "string",
              description: "Absolute path to the PDF file",
            },
            table_format: {
              type: "string",
              enum: ["markdown", "html"],
              default: "html",
              description: "Output format for tables: 'html' or 'markdown'",
            },
            pages: {
              type: "string",
              description: "Specific pages to process (e.g., '1,5-10')",
            },
            save_to_file: {
              type: "boolean",
              default: true,
              description: "Save extracted tables to file",
            },
            return_content: {
              type: "boolean",
              default: true,
              description: "Return table content in JSON response",
            },
          },
          required: ["file_path"],
        },
        annotations: {
          title: "Extract Tables from PDF",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: "mistral_ocr_clean_markdown",
        description:
          "Clean repetitive content from markdown text. " +
          "This utility tool removes repetitive headers, author names, and other " +
          "noise from OCR-extracted markdown while preserving page numbers, " +
          "journal titles, and footnotes. Optimized for Arabic/English academic papers.",
        inputSchema: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "Markdown content to clean",
            },
            config_path: {
              type: "string",
              description:
                "Path to custom markdowncleaner YAML config. Uses default config if not specified",
            },
          },
          required: ["content"],
        },
        annotations: {
          title: "Clean Markdown Content",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
    ],
  };
});

// =============================================================================
// Tool Handlers
// =============================================================================

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "mistral_ocr_process_pdf") {
      const params = ProcessPdfInputSchema.parse(args);

      // Validate file path
      const pdfPath = expandPath(params.file_path);
      try {
        await fs.access(pdfPath);
      } catch {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: `PDF file not found: ${params.file_path}`,
                suggestion:
                  "Please provide an absolute path to an existing PDF file.",
              }),
            },
          ],
          isError: true,
        };
      }

      if (!pdfPath.toLowerCase().endsWith(".pdf")) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: `Expected a PDF file, got: ${path.extname(pdfPath)}`,
                suggestion: "Ensure the file has a .pdf extension.",
              }),
            },
          ],
          isError: true,
        };
      }

      // Parse page specification
      let pageNumbers: Set<number> | undefined;
      if (params.pages) {
        try {
          pageNumbers = parsePageSpec(params.pages);
        } catch (e: any) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: false,
                  error: `Invalid page specification: ${e.message}`,
                  suggestion: "Use format like '1,5,10-15' for page selection.",
                }),
              },
            ],
            isError: true,
          };
        }
      }

      // Process OCR
      const ocrResult = await processPdfOcr(
        pdfPath,
        DEFAULT_MODEL,
        pageNumbers,
        params.extract_header,
        params.extract_footer,
        params.table_format,
        params.include_images,
        params.include_hyperlinks
      );

      let { markdown_content } = ocrResult;
      const { total_pages, pages_processed, warnings } = ocrResult;

      // Clean markdown if requested
      let cleaned = false;
      let configUsed: string | null = null;
      if (params.clean_output && params.output_format === "markdown") {
        const [cleanedContent, config] = cleanMarkdownContent(markdown_content);
        markdown_content = cleanedContent;
        configUsed = config;
        cleaned = !config.includes("skipped");
      }

      // Convert to text if needed
      const finalContent =
        params.output_format === "text"
          ? markdownToText(markdown_content)
          : markdown_content;

      // Save to file if requested
      let outputFile: string | null = null;
      if (params.save_to_file) {
        const ext = params.output_format === "text" ? ".txt" : ".md";
        const outputPath = pdfPath.replace(/\.pdf$/i, ext);
        await fs.writeFile(outputPath, finalContent, "utf-8");
        outputFile = outputPath;
      }

      // Build response
      const response: any = {
        success: true,
        content: params.return_content ? finalContent : null,
        page_count: total_pages,
        pages_processed,
        output_file: outputFile,
        format: params.output_format,
        cleaned,
        config_used: configUsed,
        warnings,
      };

      if (params.table_format && ocrResult.tables) {
        response.tables = ocrResult.tables;
      }
      if (params.include_images && ocrResult.images) {
        response.images = ocrResult.images;
      }
      if (params.include_hyperlinks && ocrResult.hyperlinks) {
        response.hyperlinks = ocrResult.hyperlinks;
      }

      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    } else if (name === "mistral_ocr_process_url") {
      const params = ProcessUrlInputSchema.parse(args);

      let downloadedPdf: string | null = null;
      try {
        // Determine output directory
        const outputDir = params.output_dir || process.cwd();
        try {
          await fs.mkdir(outputDir, { recursive: true });
        } catch {
          // Directory exists or couldn't create
        }

        // Download PDF
        try {
          downloadedPdf = await downloadPdfFromUrl(params.url, outputDir);
        } catch (e: any) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: false,
                  error: `Failed to download PDF: ${e.message}`,
                  suggestion:
                    "Check the URL is accessible and points to a valid PDF.",
                }),
              },
            ],
            isError: true,
          };
        }

        // Parse page specification
        let pageNumbers: Set<number> | undefined;
        if (params.pages) {
          try {
            pageNumbers = parsePageSpec(params.pages);
          } catch (e: any) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: false,
                    error: `Invalid page specification: ${e.message}`,
                    suggestion: "Use format like '1,5,10-15' for page selection.",
                  }),
                },
              ],
              isError: true,
            };
          }
        }

        // Process OCR
        const ocrResult = await processPdfOcr(
          downloadedPdf,
          DEFAULT_MODEL,
          pageNumbers,
          params.extract_header,
          params.extract_footer,
          params.table_format,
          params.include_images,
          params.include_hyperlinks
        );

        let { markdown_content } = ocrResult;
        const { total_pages, pages_processed, warnings } = ocrResult;

        // Clean markdown if requested
        let cleaned = false;
        let configUsed: string | null = null;
        if (params.clean_output && params.output_format === "markdown") {
          const [cleanedContent, config] =
            cleanMarkdownContent(markdown_content);
          markdown_content = cleanedContent;
          configUsed = config;
          cleaned = !config.includes("skipped");
        }

        // Convert to text if needed
        const finalContent =
          params.output_format === "text"
            ? markdownToText(markdown_content)
            : markdown_content;

        // Save output file
        const ext = params.output_format === "text" ? ".txt" : ".md";
        const outputPath = downloadedPdf.replace(/\.pdf$/i, ext);
        await fs.writeFile(outputPath, finalContent, "utf-8");

        // Handle PDF cleanup
        let pdfFile: string | null = null;
        if (params.keep_pdf) {
          pdfFile = downloadedPdf;
        } else {
          await fs.unlink(downloadedPdf);
        }

        // Build response
        const response: any = {
          success: true,
          content: params.return_content ? finalContent : null,
          page_count: total_pages,
          pages_processed,
          output_file: outputPath,
          pdf_file: pdfFile,
          format: params.output_format,
          cleaned,
          config_used: configUsed,
          warnings,
        };

        if (params.table_format && ocrResult.tables) {
          response.tables = ocrResult.tables;
        }
        if (params.include_images && ocrResult.images) {
          response.images = ocrResult.images;
        }
        if (params.include_hyperlinks && ocrResult.hyperlinks) {
          response.hyperlinks = ocrResult.hyperlinks;
        }

        return {
          content: [{ type: "text", text: JSON.stringify(response) }],
        };
      } catch (e: any) {
        // Cleanup on error
        if (downloadedPdf && !params.keep_pdf) {
          try {
            await fs.unlink(downloadedPdf);
          } catch {
            // Ignore cleanup errors
          }
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: `Processing failed: ${e.message}`,
                suggestion:
                  e.message.includes("MISTRAL_API_KEY")
                    ? "Check your MISTRAL_API_KEY environment variable."
                    : "Ensure the URL points to a valid PDF file.",
              }),
            },
          ],
          isError: true,
        };
      }
    } else if (name === "mistral_ocr_process_image") {
      const params = ProcessImageInputSchema.parse(args);

      try {
        // Process image OCR
        const [markdownContent, warnings] = await processImageOcr(
          params.image_source,
          params.source_type
        );

        // Clean markdown if requested
        let cleaned = false;
        let configUsed: string | null = null;
        let finalMarkdown = markdownContent;
        if (params.clean_output && params.output_format === "markdown") {
          const [cleanedContent, config] = cleanMarkdownContent(markdownContent);
          finalMarkdown = cleanedContent;
          configUsed = config;
          cleaned = !config.includes("skipped");
        }

        // Convert to text if needed
        const finalContent =
          params.output_format === "text"
            ? markdownToText(finalMarkdown)
            : finalMarkdown;

        // Save to file if requested
        let outputFile: string | null = null;
        if (params.save_to_file) {
          let outputPath: string;
          const ext = params.output_format === "text" ? ".txt" : ".md";

          if (params.source_type === "file") {
            const basePath = expandPath(params.image_source);
            outputPath = basePath.replace(/\.[^.]+$/, ext);
          } else {
            outputPath = path.join(process.cwd(), `ocr_output${ext}`);
          }

          await fs.writeFile(outputPath, finalContent, "utf-8");
          outputFile = outputPath;
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                content: params.return_content ? finalContent : null,
                output_file: outputFile,
                format: params.output_format,
                cleaned,
                config_used: configUsed,
                warnings,
              }),
            },
          ],
        };
      } catch (e: any) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: e.message.includes("not found")
                  ? e.message
                  : `Image OCR processing failed: ${e.message}`,
                suggestion: e.message.includes("not found")
                  ? "Check that the image file exists at the specified path."
                  : e.message.includes("MISTRAL_API_KEY")
                  ? "Check your MISTRAL_API_KEY environment variable or source_type parameter."
                  : "Ensure the image is valid and in a supported format (PNG, JPG, etc.).",
              }),
            },
          ],
          isError: true,
        };
      }
    } else if (name === "mistral_ocr_extract_structured") {
      const params = ExtractStructuredInputSchema.parse(args);

      try {
        // Validate file path
        const filePath = expandPath(params.file_path);
        try {
          await fs.access(filePath);
        } catch {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: false,
                  error: `File not found: ${params.file_path}`,
                  suggestion:
                    "Please provide an absolute path to an existing file.",
                }),
              },
            ],
            isError: true,
          };
        }

        // Parse and validate schema
        let schema: Record<string, any>;
        try {
          schema = buildSchemaFromJson(params.json_schema);
        } catch (e: any) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: false,
                  error: e.message,
                  suggestion: "Ensure json_schema is valid JSON schema format.",
                }),
              },
            ],
            isError: true,
          };
        }

        // Parse page specification
        let pageNumbers: Set<number> | undefined;
        if (params.pages) {
          try {
            pageNumbers = parsePageSpec(params.pages);
            if (pageNumbers.size > 8) {
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      success: false,
                      error: `Document annotation is limited to 8 pages (requested ${pageNumbers.size})`,
                      suggestion:
                        "Use pages parameter to select 8 or fewer pages.",
                    }),
                  },
                ],
                isError: true,
              };
            }
          } catch (e: any) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: false,
                    error: `Invalid page specification: ${e.message}`,
                    suggestion: "Use format like '1,5-8' for page selection.",
                  }),
                },
              ],
              isError: true,
            };
          }
        }

        const apiKey = getApiKey();
        const client = new Mistral({ apiKey });
        const warnings: string[] = [];

        // Determine if it's a PDF or image
        const ext = path.extname(filePath).toLowerCase();
        const isPdf = ext === ".pdf";

        let document: any;
        if (isPdf) {
          const fileBytes = await fs.readFile(filePath);
          const blob = new Blob([fileBytes]);

          const uploaded = await client.files.upload({
            file: blob as any,
            purpose: "ocr",
          });

          const signedUrlResponse = await client.files.getSignedUrl({
            fileId: uploaded.id!,
          });

          document = {
            type: "document_url",
            documentUrl: signedUrlResponse.url,
          };
        } else {
          const imageUrl = encodeImageToBase64(filePath);
          document = { type: "image_url", imageUrl };
        }

        // Build OCR request with document annotation
        const ocrParams: any = {
          document,
          model: DEFAULT_MODEL,
          includeImageBase64: params.include_images,
        };

        // Add annotation format if supported
        if (params.annotation_type === "document") {
          (ocrParams as any).documentAnnotationFormat = schema;
        }

        // Process OCR
        let response;
        try {
          response = await client.ocr.process(ocrParams);
        } catch (e: any) {
          // Fallback if annotation format not supported
          if (
            e.message &&
            e.message.includes("documentAnnotationFormat")
          ) {
            warnings.push(
              "Document annotation format not supported in current API version"
            );
            delete ocrParams.documentAnnotationFormat;
            response = await client.ocr.process(ocrParams);
          } else {
            throw e;
          }
        }

        // Extract structured data from response
        let extractedData: any = null;
        if ((response as any).documentAnnotation) {
          extractedData = (response as any).documentAnnotation;
        } else if ((response as any).annotations) {
          extractedData = (response as any).annotations;
        }

        // Count pages
        const totalPages = response.pages ? response.pages.length : 0;
        let pagesProcessed = Array.from(
          { length: totalPages },
          (_, i) => i + 1
        );

        if (pageNumbers && totalPages > 8) {
          warnings.push(
            `Document has ${totalPages} pages but only first 8 were processed for annotation`
          );
          pagesProcessed = pagesProcessed.slice(0, 8);
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                extracted_data: extractedData,
                page_count: totalPages,
                pages_processed: totalPages > 8 ? pagesProcessed.slice(0, 8) : pagesProcessed,
                schema_used: params.json_schema,
                warnings,
              }),
            },
          ],
        };
      } catch (e: any) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: e.message.includes("MISTRAL_API_KEY")
                  ? e.message
                  : `Structured extraction failed: ${e.message}`,
                suggestion: e.message.includes("MISTRAL_API_KEY")
                  ? "Check your MISTRAL_API_KEY environment variable."
                  : "Ensure the file is valid and the schema is correct.",
              }),
            },
          ],
          isError: true,
        };
      }
    } else if (name === "mistral_ocr_extract_tables") {
      const params = ExtractTablesInputSchema.parse(args);

      try {
        // Validate file path
        const pdfPath = expandPath(params.file_path);
        try {
          await fs.access(pdfPath);
        } catch {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: false,
                  error: `PDF file not found: ${params.file_path}`,
                  suggestion:
                    "Please provide an absolute path to an existing PDF file.",
                }),
              },
            ],
            isError: true,
          };
        }

        if (!pdfPath.toLowerCase().endsWith(".pdf")) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: false,
                  error: `Expected a PDF file, got: ${path.extname(pdfPath)}`,
                  suggestion: "Ensure the file has a .pdf extension.",
                }),
              },
            ],
            isError: true,
          };
        }

        // Parse page specification
        let pageNumbers: Set<number> | undefined;
        if (params.pages) {
          try {
            pageNumbers = parsePageSpec(params.pages);
          } catch (e: any) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: false,
                    error: `Invalid page specification: ${e.message}`,
                    suggestion: "Use format like '1,5,10-15' for page selection.",
                  }),
                },
              ],
              isError: true,
            };
          }
        }

        // Process OCR with table extraction
        const ocrResult = await processPdfOcr(
          pdfPath,
          DEFAULT_MODEL,
          pageNumbers,
          true,
          true,
          params.table_format
        );

        const tables = ocrResult.tables || [];
        const { total_pages, pages_processed, warnings } = ocrResult;

        // Save tables to file if requested
        let outputFile: string | null = null;
        if (params.save_to_file && tables.length > 0) {
          const ext = params.table_format === "html" ? ".html" : ".md";
          const baseName = path.basename(pdfPath, ".pdf");
          const dirName = path.dirname(pdfPath);
          const outputPath = path.join(dirName, `${baseName}_tables${ext}`);

          let tableContent: string;
          if (params.table_format === "html") {
            tableContent = tables
              .map(
                (t: any) =>
                  `<!-- Table ${t.id} from page ${t.page} -->\n${t.content}`
              )
              .join("\n\n");
          } else {
            tableContent = tables
              .map(
                (t: any) =>
                  `## Table ${t.id} (Page ${t.page})\n\n${t.content}`
              )
              .join("\n\n");
          }

          await fs.writeFile(outputPath, tableContent, "utf-8");
          outputFile = outputPath;
        }

        // Build response
        const response: any = {
          success: true,
          table_count: tables.length,
          page_count: total_pages,
          pages_processed,
          output_file: outputFile,
          format: params.table_format,
          warnings,
        };

        if (params.return_content) {
          response.tables = tables;
        }

        return {
          content: [{ type: "text", text: JSON.stringify(response) }],
        };
      } catch (e: any) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: e.message.includes("MISTRAL_API_KEY")
                  ? e.message
                  : `Table extraction failed: ${e.message}`,
                suggestion: e.message.includes("MISTRAL_API_KEY")
                  ? "Check your MISTRAL_API_KEY environment variable."
                  : "Ensure the PDF is valid and contains tables.",
              }),
            },
          ],
          isError: true,
        };
      }
    } else if (name === "mistral_ocr_clean_markdown") {
      const params = CleanMarkdownInputSchema.parse(args);

      try {
        const originalLength = params.content.length;

        const [cleanedContent, configUsed] = cleanMarkdownContent(
          params.content
        );
        const cleanedLength = cleanedContent.length;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                content: cleanedContent,
                original_length: originalLength,
                cleaned_length: cleanedLength,
                reduction_percent:
                  originalLength > 0
                    ? Math.round(
                        ((1 - cleanedLength / originalLength) * 100) * 10
                      ) / 10
                    : 0,
                config_used: configUsed,
              }),
            },
          ],
        };
      } catch (e: any) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: `Cleaning failed: ${e.message}`,
                suggestion: "Ensure the content is valid markdown text.",
              }),
            },
          ],
          isError: true,
        };
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: false,
            error: `Unknown tool: ${name}`,
          }),
        },
      ],
      isError: true,
    };
  } catch (e: any) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: false,
            error: `Tool execution failed: ${e.message}`,
            suggestion: "Check the input parameters and try again.",
          }),
        },
      ],
      isError: true,
    };
  }
});

// =============================================================================
// Entry Point
// =============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Mistral OCR MCP server running on stdio");
}

main();
