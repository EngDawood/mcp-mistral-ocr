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
import { parsePageSpec, markdownToText, cleanMarkdown, buildSchemaFromJson } from "./shared/utils.js";
import { normalizeSourceUrl } from "./shared/source-url.js";
import { ocrProcess } from "./shared/ocr-api.js";
import { applyRtlColumnOrder, type RtlMode } from "./shared/rtl-layout.js";

// Constants
const DEFAULT_OCR_MODEL = "mistral-ocr-latest";

// Module-level env reference, set on each request in the fetch handler.
// Safe because Cloudflare Workers are single-threaded per isolate.
let _env: any;
// User-provided API key from query parameter (overrides env secret)
let _userApiKey: string | null = null;

function getOcrModel(): string {
  return _env?.OCR_MODEL || DEFAULT_OCR_MODEL;
}

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
  rtl_columns: z.enum(["auto", "on", "off"]).default("auto").describe(
    "Reading order of multi-column pages. Mistral OCR always returns columns left-to-right, " +
    "which reverses a two-column Arabic or Hebrew page. 'auto' repairs the order for pages " +
    "detected as right-to-left, 'on' forces it, 'off' returns the OCR order unchanged."
  ),
});

const ProcessImageInputSchema = z.object({
  image_source: z.string().min(1, "Image source cannot be empty"),
  source_type: z.enum(["url", "base64"]).default("url"), // Removed "file" option
  output_format: z.enum(["markdown", "text"]).default("text"),
  clean_output: z.boolean().default(false),
  rtl_columns: z.enum(["auto", "on", "off"]).default("auto").describe(
    "Reading order of multi-column pages. Mistral OCR always returns columns left-to-right, " +
    "which reverses a two-column Arabic or Hebrew page. 'auto' repairs the order for pages " +
    "detected as right-to-left, 'on' forces it, 'off' returns the OCR order unchanged."
  ),
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

function getApiKey(): string {
  // Priority: user query param > user secret > default fallback
  const apiKey = _userApiKey || _env?.MISTRAL_API_KEY || _env?.DEFAULT_MISTRAL_API_KEY;
  if (!apiKey) {
    throw new Error(
      "MISTRAL_API_KEY not found. Pass ?apiKey=YOUR_KEY in the URL or configure via wrangler secret."
    );
  }
  return apiKey;
}

// Secondary key, used only when the primary key hits Mistral's rate limit.
function getBackupApiKey(): string | undefined {
  return _env?.MISTRAL_API_KEY_BACKUP || undefined;
}

function isRateLimitError(error: any): boolean {
  if (error?.statusCode === 429) return true;
  return /\b429\b|rate.?limit/i.test(String(error?.message ?? error));
}

// Runs fn with the primary key; on a 429 from Mistral, retries once with
// MISTRAL_API_KEY_BACKUP if one is configured and differs from the primary key.
async function withRateLimitFallback<T>(
  primaryKey: string,
  fn: (apiKey: string) => Promise<T>
): Promise<T> {
  try {
    return await fn(primaryKey);
  } catch (error: any) {
    const backupKey = getBackupApiKey();
    if (backupKey && backupKey !== primaryKey && isRateLimitError(error)) {
      return await fn(backupKey);
    }
    throw error;
  }
}

async function processImageOcr(
  imageSource: string,
  sourceType: string,
  apiKey: string,
  model?: string,
  rtlColumns: RtlMode = "auto"
): Promise<[string, string[]]> {
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

  const response = await ocrProcess(apiKey, {
    document: { type: "image_url", imageUrl },
    model: model || getOcrModel(),
    // A scan of a two-column page needs the same reading-order repair a PDF does.
    includeBlocks: rtlColumns !== "off",
  });

  if (!response.pages || !Array.isArray(response.pages)) {
    throw new Error("Unexpected OCR response format: no pages returned");
  }

  const rtl = applyRtlColumnOrder(response.pages, rtlColumns);
  warnings.push(...rtl.warnings);
  return [rtl.markdown.join("\n\n"), warnings];
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
  model?: string,
  rtlColumns: RtlMode = "auto"
): Promise<any> {
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
    model: model || getOcrModel(),
    // Paragraph positions, so a right-to-left page can be put back in reading
    // order (see ./shared/rtl-layout.ts).
    includeBlocks: rtlColumns !== "off",
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
    ocrResponse = await ocrProcess(apiKey, ocrParams);
  } catch (error: any) {
    if (error instanceof TypeError || String(error?.message).includes("extract_header")) {
      delete (ocrParams as any).extractHeader;
      delete (ocrParams as any).extractFooter;
      warnings.push("extract_header/extract_footer not supported, retrying without them");
      ocrResponse = await ocrProcess(apiKey, ocrParams);
    } else {
      throw error;
    }
  }

  if (!ocrResponse.pages || !Array.isArray(ocrResponse.pages)) {
    throw new Error("Unexpected OCR response format: no pages returned");
  }

  // Repair the column order before the pages are joined into one document.
  const allPages = ocrResponse.pages as any[];
  const rtl = applyRtlColumnOrder(allPages, rtlColumns);
  if (rtl.applied) {
    allPages.forEach((page: any, i: number) => {
      page.markdown = rtl.markdown[i];
    });
  }
  warnings.push(...rtl.warnings);

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
    for (const page of ocrResponse.pages as any[]) {
      if (page.tables) {
        for (const table of page.tables) {
          tables.push({
            page: page.index,
            format: tableFormat,
            content: (table as any)[tableFormat] ?? table.markdown,
          });
        }
      }
    }
  }

  // Extract images
  let images: any[] = [];
  if (includeImages && ocrResponse.pages) {
    for (const page of ocrResponse.pages as any[]) {
      if (page.images) {
        for (const img of page.images) {
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
  async (params: Record<string, unknown>) => {
    try {
      const input = ProcessUrlInputSchema.parse(params);
      const apiKey = getApiKey();

      // Share links serve a viewer page rather than the file. Note that Mistral
      // fetches the URL itself here (no filesystem, no proxy on this surface),
      // so a rewritten link still depends on Google answering Mistral's fetcher.
      const result = await withRateLimitFallback(apiKey, (key) =>
        processPdfOcr(
          normalizeSourceUrl(input.url).url,
          "url",
          key,
          input.output_format,
          input.pages,
          input.extract_header,
          input.extract_footer,
          input.table_format,
          input.include_images,
          input.include_hyperlinks,
          undefined,
          input.rtl_columns
        )
      );

      if (input.clean_output && result.content) {
        result.content = cleanMarkdown(result.content);
        result.cleaned = true;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text" as const,
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
  async (params: Record<string, unknown>) => {
    try {
      const input = ProcessImageInputSchema.parse(params);
      const apiKey = getApiKey();

      const [content, warnings] = await withRateLimitFallback(apiKey, (key) =>
        processImageOcr(input.image_source, input.source_type, key, undefined, input.rtl_columns)
      );

      let finalContent = content;
      if (input.output_format === "text") {
        finalContent = markdownToText(content);
      }

      if (input.clean_output) {
        finalContent = cleanMarkdown(finalContent);
      }

      return {
        content: [
          {
            type: "text" as const,
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
            type: "text" as const,
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
  async (params: Record<string, unknown>) => {
    try {
      const input = ExtractStructuredInputSchema.parse(params);
      const apiKey = getApiKey();

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
        model: getOcrModel(),
      };

      (ocrParams as any).documentAnnotationFormat = schema;

      if (input.pages) {
        const pageSet = parsePageSpec(input.pages);
        ocrParams.pages = Array.from(pageSet);
      }

      const response = await withRateLimitFallback(apiKey, (key) =>
        new Mistral({ apiKey: key }).ocr.process(ocrParams)
      );

      return {
        content: [
          {
            type: "text" as const,
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
            type: "text" as const,
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
  async (params: Record<string, unknown>) => {
    try {
      const input = ExtractTablesInputSchema.parse(params);
      const apiKey = getApiKey();

      const result = await withRateLimitFallback(apiKey, (key) =>
        processPdfOcr(
          input.source,
          input.source_type,
          key,
          "markdown",
          input.pages,
          true,
          true,
          input.table_format,
          false,
          false
        )
      );

      return {
        content: [
          {
            type: "text" as const,
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
            type: "text" as const,
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
  async (params: Record<string, unknown>) => {
    try {
      const input = CleanMarkdownInputSchema.parse(params);
      const cleanedContent = cleanMarkdown(input.content);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              cleaned_content: cleanedContent,
              method: "lightweight inline deduplication",
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
            type: "text" as const,
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

    // Check for MCP authentication (required if MCP_AUTH_KEY is set)
    const mcpAuthKey = env.MCP_AUTH_KEY;
    if (mcpAuthKey) {
      // Accept auth key from Authorization header or query parameter
      const authHeader = request.headers.get("Authorization");
      const authFromHeader = authHeader?.replace("Bearer ", "");
      const authFromQuery = url.searchParams.get("auth");
      const providedAuth = authFromHeader || authFromQuery;

      if (!providedAuth || providedAuth !== mcpAuthKey) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Optional: User can provide their own Mistral API key
    _userApiKey = url.searchParams.get("apiKey");

    return createMcpHandler(server)(request, env, ctx);
  },
};