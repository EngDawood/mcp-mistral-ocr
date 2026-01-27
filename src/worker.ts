/**
 * Cloudflare Worker MCP Server for PDF OCR using Mistral AI
 *
 * Remote HTTP/SSE transport version for deployment to Cloudflare Workers.
 *
 * Supported Tools:
 * - mistral_ocr_process_url: Download and process PDF from URL
 * - mistral_ocr_process_image: Process image (URL or base64)
 * - mistral_ocr_extract_structured: Extract structured data from URL/base64
 * - mistral_ocr_extract_tables: Extract tables from URL/base64
 * - mistral_ocr_clean_markdown: Clean repetitive markdown content
 *
 * Note: File-based operations are not supported in Workers (no filesystem).
 * Use URLs or base64-encoded content instead.
 */

import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Mistral } from "@mistralai/mistralai";
import { z } from "zod";

// Constants
const DEFAULT_MODEL = "mistral-ocr-latest";

// Module-level env reference, set on each request in the fetch handler.
// Safe because Cloudflare Workers are single-threaded per isolate.
let _env: any;
// User-provided API key from query parameter (overrides env secret)
let _userApiKey: string | null = null;

// =============================================================================
// Zod Input Schemas (Worker-compatible versions)
// =============================================================================

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
  table_format: z.enum(["markdown", "html"]).optional(),
  include_images: z.boolean().default(false),
  include_hyperlinks: z.boolean().default(false),
});

const ProcessImageInputSchema = z.object({
  image_source: z.string().min(1, "Image source cannot be empty"),
  source_type: z.enum(["url", "base64"]).default("url"), // Removed "file" option
  output_format: z.enum(["markdown", "text"]).default("text"),
  clean_output: z.boolean().default(false),
});

const ExtractStructuredInputSchema = z.object({
  source: z.string().min(1, "Source cannot be empty"),
  source_type: z.enum(["url", "base64"]).default("url"),
  json_schema: z.string().min(1, "JSON schema cannot be empty"),
  pages: z.string().optional(),
  annotation_type: z.enum(["document", "bbox"]).default("document"),
  include_images: z.boolean().default(false),
});

const ExtractTablesInputSchema = z.object({
  source: z.string().min(1, "Source cannot be empty"),
  source_type: z.enum(["url", "base64"]).default("url"),
  table_format: z.enum(["markdown", "html"]).default("html"),
  pages: z.string().optional(),
});

const CleanMarkdownInputSchema = z.object({
  content: z.string().min(1, "Content cannot be empty"),
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
  const lines = content.split("\n");
  const lineCounts = new Map<string, number>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      lineCounts.set(trimmed, (lineCounts.get(trimmed) || 0) + 1);
    }
  }

  const repetitiveLines = new Set<string>();
  for (const [line, count] of lineCounts.entries()) {
    if (count >= 3) {
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

  const cleanedLines = lines.filter((line) => {
    const trimmed = line.trim();
    return trimmed.length === 0 || !repetitiveLines.has(trimmed);
  });

  const cleanedContent = cleanedLines.join("\n");
  return [cleanedContent, "lightweight inline deduplication"];
}

function getApiKey(): string {
  const apiKey = _userApiKey || _env?.MISTRAL_API_KEY;
  if (!apiKey) {
    throw new Error(
      "MISTRAL_API_KEY not found. Pass ?apiKey=YOUR_KEY in the URL or configure via wrangler secret."
    );
  }
  return apiKey;
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
  apiKey: string,
  model: string = DEFAULT_MODEL
): Promise<[string, string[]]> {
  const client = new Mistral({ apiKey });
  const warnings: string[] = [];

  let imageUrl: string;
  if (sourceType === "url") {
    imageUrl = imageSource;
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
  });

  if (!response.pages || !Array.isArray(response.pages)) {
    throw new Error("Unexpected OCR response format: no pages returned");
  }

  const content = (response.pages as any[]).map((page: any) => page.markdown).join("\n\n");
  return [content, warnings];
}

async function processPdfOcr(
  pdfSource: string,
  sourceType: "url" | "base64",
  apiKey: string,
  outputFormat: "markdown" | "text" = "text",
  pages?: string,
  extractHeader: boolean = true,
  extractFooter: boolean = true,
  tableFormat?: "markdown" | "html",
  includeImages: boolean = false,
  includeHyperlinks: boolean = false,
  model: string = DEFAULT_MODEL
): Promise<any> {
  const client = new Mistral({ apiKey });
  const warnings: string[] = [];

  // Build OCR document reference
  let documentRef: any;

  if (sourceType === "url") {
    // Pass URL directly to OCR API — no download/upload needed
    documentRef = { type: "document_url", documentUrl: pdfSource };
  } else {
    // base64: pass as data URI
    const base64Data = pdfSource.includes(",") ? pdfSource.split(",")[1] : pdfSource;
    documentRef = {
      type: "document_url",
      documentUrl: `data:application/pdf;base64,${base64Data}`,
    };
  }

  // Build OCR parameters
  const ocrParams: any = {
    document: documentRef,
    model,
    includeBreakdown: true,
  };

  if (pages) {
    const pageSet = parsePageSpec(pages);
    ocrParams.pages = Array.from(pageSet);
  }

  // Try with header/footer extraction first
  let ocrResponse;
  try {
    (ocrParams as any).extractHeader = extractHeader;
    (ocrParams as any).extractFooter = extractFooter;
    ocrResponse = await client.ocr.process(ocrParams);
  } catch (error: any) {
    if (error instanceof TypeError) {
      delete (ocrParams as any).extractHeader;
      delete (ocrParams as any).extractFooter;
      warnings.push("extract_header/extract_footer not supported, retrying without them");
      ocrResponse = await client.ocr.process(ocrParams);
    } else {
      throw error;
    }
  }

  if (!ocrResponse.pages || !Array.isArray(ocrResponse.pages)) {
    throw new Error("Unexpected OCR response format: no pages returned");
  }

  // Join all page markdown content
  const allPages = ocrResponse.pages as any[];
  let content = allPages.map((page: any) => page.markdown).join("\n\n");
  const pageCount = allPages.length;
  const pagesProcessed = ocrParams.pages || Array.from({ length: pageCount }, (_: any, i: number) => i + 1);

  // Convert format
  if (outputFormat === "text") {
    content = markdownToText(content);
  }

  // Extract tables
  let tables: any[] = [];
  if (tableFormat && ocrResponse.pages) {
    for (const page of ocrResponse.pages) {
      if (page.markdown?.tables) {
        for (const table of page.markdown.tables) {
          tables.push({
            page: page.index,
            format: tableFormat,
            content: tableFormat === "html" ? table.html : table.markdown,
          });
        }
      }
    }
  }

  // Extract images
  let images: any[] = [];
  if (includeImages && ocrResponse.pages) {
    for (const page of ocrResponse.pages) {
      if (page.markdown?.images) {
        for (const img of page.markdown.images) {
          images.push({
            page: page.index,
            url: img.url,
            alt: img.description || "",
          });
        }
      }
    }
  }

  // Extract hyperlinks
  let hyperlinks: any[] = [];
  if (includeHyperlinks) {
    const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
    let match;
    while ((match = linkPattern.exec(content)) !== null) {
      hyperlinks.push({
        text: match[1],
        url: match[2],
      });
    }
  }

  return {
    success: true,
    content,
    page_count: pageCount,
    pages_processed: pagesProcessed,
    format: outputFormat,
    warnings,
    tables: tables.length > 0 ? tables : undefined,
    images: images.length > 0 ? images : undefined,
    hyperlinks: hyperlinks.length > 0 ? hyperlinks : undefined,
  };
}

// =============================================================================
// MCP Server Setup
// =============================================================================

const server = new McpServer({
  name: "Mistral OCR MCP (Cloudflare Worker)",
  version: "1.0.0",
});

// Tool 1: Process PDF from URL
server.registerTool(
  "mistral_ocr_process_url",
  {
    description: "Download and process a PDF from a URL using Mistral OCR API",
    inputSchema: ProcessUrlInputSchema as any,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const input = ProcessUrlInputSchema.parse(params);
      const apiKey = getApiKey();

      const result = await processPdfOcr(
        input.url,
        "url",
        apiKey,
        input.output_format,
        input.pages,
        input.extract_header,
        input.extract_footer,
        input.table_format,
        input.include_images,
        input.include_hyperlinks
      );

      if (input.clean_output && result.content) {
        const [cleanedContent] = cleanMarkdownContent(result.content);
        result.content = cleanedContent;
        result.cleaned = true;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              error: error.message,
              suggestion: "Check URL is valid and points to a PDF file",
            }, null, 2),
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool 2: Process Image
server.registerTool(
  "mistral_ocr_process_image",
  {
    description: "Process an image using Mistral OCR API (URL or base64)",
    inputSchema: ProcessImageInputSchema as any,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const input = ProcessImageInputSchema.parse(params);
      const apiKey = getApiKey();

      const [content, warnings] = await processImageOcr(
        input.image_source,
        input.source_type,
        apiKey
      );

      let finalContent = content;
      if (input.output_format === "text") {
        finalContent = markdownToText(content);
      }

      if (input.clean_output) {
        const [cleanedContent] = cleanMarkdownContent(finalContent);
        finalContent = cleanedContent;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              content: finalContent,
              format: input.output_format,
              warnings,
            }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              error: error.message,
              suggestion: "Check image source is valid URL or base64 data",
            }, null, 2),
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool 3: Extract Structured Data
server.registerTool(
  "mistral_ocr_extract_structured",
  {
    description: "Extract structured data from PDF/image using JSON schema (URL or base64)",
    inputSchema: ExtractStructuredInputSchema as any,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const input = ExtractStructuredInputSchema.parse(params);
      const apiKey = getApiKey();
      const client = new Mistral({ apiKey });

      const schema = buildSchemaFromJson(input.json_schema);

      // Determine document type and prepare source
      let documentRef: any;

      if (input.source_type === "url") {
        const lowerSource = input.source.toLowerCase();
        if (lowerSource.endsWith(".pdf")) {
          documentRef = { type: "document_url", documentUrl: input.source };
        } else {
          documentRef = { type: "image_url", imageUrl: input.source };
        }
      } else {
        // base64
        const src = input.source.startsWith("data:")
          ? input.source
          : `data:image/png;base64,${input.source}`;
        documentRef = { type: "image_url", imageUrl: src };
      }

      const ocrParams: any = {
        document: documentRef,
        model: DEFAULT_MODEL,
      };

      (ocrParams as any).documentAnnotationFormat = schema;

      if (input.pages) {
        const pageSet = parsePageSpec(input.pages);
        ocrParams.pages = Array.from(pageSet);
      }

      const response = await client.ocr.process(ocrParams);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              structured_data: (response as any).documentAnnotation || (response.pages as any[])?.map((p: any) => p.markdown).join("\n\n"),
              annotation_type: input.annotation_type,
            }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              error: error.message,
              suggestion: "Check source and JSON schema are valid",
            }, null, 2),
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool 4: Extract Tables
server.registerTool(
  "mistral_ocr_extract_tables",
  {
    description: "Extract tables from PDF/image in HTML or markdown format (URL or base64)",
    inputSchema: ExtractTablesInputSchema as any,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const input = ExtractTablesInputSchema.parse(params);
      const apiKey = getApiKey();

      const result = await processPdfOcr(
        input.source,
        input.source_type,
        apiKey,
        "markdown",
        input.pages,
        true,
        true,
        input.table_format,
        false,
        false
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              tables: result.tables || [],
              page_count: result.page_count,
              table_format: input.table_format,
            }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              error: error.message,
              suggestion: "Check source is valid",
            }, null, 2),
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool 5: Clean Markdown
server.registerTool(
  "mistral_ocr_clean_markdown",
  {
    description: "Clean repetitive content from markdown text (removes headers/footers appearing 3+ times)",
    inputSchema: CleanMarkdownInputSchema as any,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
  },
  async (params) => {
    try {
      const input = CleanMarkdownInputSchema.parse(params);
      const [cleanedContent, method] = cleanMarkdownContent(input.content);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              cleaned_content: cleanedContent,
              method,
              original_length: input.content.length,
              cleaned_length: cleanedContent.length,
            }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              error: error.message,
            }, null, 2),
          },
        ],
        isError: true,
      };
    }
  }
);

// =============================================================================
// Worker Export
// =============================================================================

export default {
  fetch: (request: Request, env: any, ctx: any) => {
    _env = env;
    const url = new URL(request.url);
    _userApiKey = url.searchParams.get("apiKey");
    return createMcpHandler(server)(request, env, ctx);
  },
};