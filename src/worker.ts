/**
 * Cloudflare Worker MCP server backed by the docling-api Worker.
 *
 * Remote HTTP/SSE transport. No filesystem here, so sources are URLs or base64.
 *
 * Tools:
 * - docling_convert:        URL or base64 document/image -> text or markdown
 * - docling_transcribe:     URL or base64 audio -> text
 * - docling_extract_tables: URL or base64 document -> tables as markdown
 * - docling_clean_markdown: Remove repeated headers/footers
 * - docling_usage:          Container time used this month
 *
 * Env: DOCLING_URL (var), DOCLING_API_KEY (secret), MCP_AUTH_KEY (optional secret).
 */

import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cleanMarkdown, parsePageSpec } from "./shared/utils.js";
import { normalizeSourceUrl } from "./shared/source-url.js";
import {
  convertBytes,
  convertUrl,
  getUsage,
  transcribe,
  type ConvertOptions,
  type ConvertResult,
  type DoclingClient,
} from "./shared/docling.js";
import { extractHyperlinks, extractTables, finalize, parseLangs } from "./shared/convert.js";

// Module-level env reference, set on each request in the fetch handler.
// Safe because Cloudflare Workers are single-threaded per isolate.
let _env: any;

function getClient(): DoclingClient {
  const baseUrl = _env?.DOCLING_URL;
  const apiKey = _env?.DOCLING_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("DOCLING_URL and DOCLING_API_KEY must be configured on the Worker.");
  }
  return { baseUrl, apiKey };
}

// =============================================================================
// Zod Input Schemas
// =============================================================================

const sourceFields = {
  source: z.string().min(1, "Source cannot be empty").describe(
    "An http(s) URL, or the file's bytes as base64 (a data: URI is accepted)."
  ),
  source_type: z.enum(["url", "base64"]).default("url"),
  filename: z.string().optional().describe(
    "Name with extension for base64 sources, e.g. 'scan.pdf'. Docling infers the file type from it. Default 'document.pdf'."
  ),
  pages: z.string().optional().describe("Pages to keep, e.g. '1,5,10-15'. PDFs only."),
  force_ocr: z.boolean().default(false),
  ocr_lang: z.string().optional().describe("OCR languages, comma separated. Default 'ar,en'."),
};

const ConvertInputSchema = z.object({
  ...sourceFields,
  output_format: z.enum(["markdown", "text"]).default("text"),
  clean_output: z.boolean().default(false),
  images: z.enum(["drop", "keep", "embed"]).default("drop"),
  include_hyperlinks: z.boolean().default(false),
});

const TranscribeInputSchema = z.object({
  source: z.string().min(1, "Source cannot be empty").describe("An http(s) URL, or the audio bytes as base64."),
  source_type: z.enum(["url", "base64"]).default("url"),
  content_type: z.string().default("audio/mpeg").describe("MIME type for base64 audio."),
  language: z.string().optional().describe("Spoken language code, e.g. 'ar'. Default: auto-detect."),
});

const ExtractTablesInputSchema = z.object(sourceFields);

const CleanMarkdownInputSchema = z.object({
  content: z.string().min(1, "Content cannot be empty"),
});

// =============================================================================
// Helpers
// =============================================================================

function base64ToBytes(data: string): Uint8Array {
  const raw = data.includes(",") ? data.slice(data.indexOf(",") + 1) : data;
  const binary = atob(raw.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function convert(
  input: z.infer<typeof ExtractTablesInputSchema>,
  images: ConvertOptions["images"]
): Promise<ConvertResult> {
  const opts: ConvertOptions = {
    pages: input.pages ? parsePageSpec(input.pages) : undefined,
    forceOcr: input.force_ocr,
    ocrLang: parseLangs(input.ocr_lang),
    images,
  };
  if (input.source_type === "url") {
    return convertUrl(getClient(), normalizeSourceUrl(input.source).url, opts);
  }
  return convertBytes(getClient(), base64ToBytes(input.source), input.filename ?? "document.pdf", opts);
}

function json(data: object, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    ...(isError && { isError: true }),
  };
}

function failure(error: any, fallbackSuggestion: string) {
  const message = String(error?.message ?? error);
  const suggestion = /budget/i.test(message)
    ? "The monthly container budget is used up; it resets next UTC month. See docling_usage."
    : fallbackSuggestion;
  return json({ success: false, error: message, suggestion }, true);
}

// =============================================================================
// MCP Server Setup
// =============================================================================

const server = new McpServer({
  name: "Docling MCP (Cloudflare Worker)",
  version: "2.0.0",
});

server.registerTool(
  "docling_convert",
  {
    description:
      "Convert a document (PDF, DOCX, DOC, PPTX, XLSX, XLS) or image to text or markdown using Docling. Source is a URL or base64.",
    inputSchema: ConvertInputSchema as any,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  async (params: Record<string, unknown>) => {
    try {
      const input = ConvertInputSchema.parse(params);
      const result = await convert(input, input.images);
      const { content, cleaned } = finalize(result.markdown, input.output_format, input.clean_output);
      return json({
        success: true,
        content,
        page_count: result.pages.length,
        pages_processed: result.pageNumbers,
        format: input.output_format,
        cleaned,
        warnings: result.warnings,
        ...(input.include_hyperlinks && { hyperlinks: extractHyperlinks(result.markdown) }),
      });
    } catch (error: any) {
      return failure(error, "Check the source is a valid URL or base64 and the file type is supported");
    }
  }
);

server.registerTool(
  "docling_transcribe",
  {
    description: "Transcribe audio (URL or base64, up to 25 MB) to text with Whisper.",
    inputSchema: TranscribeInputSchema as any,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  async (params: Record<string, unknown>) => {
    try {
      const input = TranscribeInputSchema.parse(params);
      const result = await transcribe(
        getClient(),
        input.source_type === "url"
          ? { url: input.source }
          : { bytes: base64ToBytes(input.source), contentType: input.content_type },
        { language: input.language }
      );
      return json({
        success: true,
        content: result.text,
        language: result.language,
        duration_seconds: result.duration,
      });
    } catch (error: any) {
      return failure(error, "Check the audio source and that it is under 25 MB");
    }
  }
);

server.registerTool(
  "docling_extract_tables",
  {
    description: "Extract the tables from a document (URL or base64) as markdown.",
    inputSchema: ExtractTablesInputSchema as any,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  async (params: Record<string, unknown>) => {
    try {
      const input = ExtractTablesInputSchema.parse(params);
      const result = await convert(input, "drop");
      const tables = extractTables(result.pages, result.pageNumbers);
      return json({
        success: true,
        tables,
        table_count: tables.length,
        page_count: result.pages.length,
        table_format: "markdown",
        warnings: result.warnings,
      });
    } catch (error: any) {
      return failure(error, "Check the source is valid");
    }
  }
);

server.registerTool(
  "docling_clean_markdown",
  {
    description: "Clean repetitive content from markdown text (removes headers/footers appearing 3+ times)",
    inputSchema: CleanMarkdownInputSchema as any,
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async (params: Record<string, unknown>) => {
    try {
      const input = CleanMarkdownInputSchema.parse(params);
      const cleanedContent = cleanMarkdown(input.content);
      return json({
        success: true,
        cleaned_content: cleanedContent,
        method: "lightweight inline deduplication",
        original_length: input.content.length,
        cleaned_length: cleanedContent.length,
      });
    } catch (error: any) {
      return json({ success: false, error: error.message }, true);
    }
  }
);

server.registerTool(
  "docling_usage",
  {
    description: "Show how much of this month's container-time budget has been used.",
    inputSchema: z.object({}) as any,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  async () => {
    try {
      const usage = await getUsage(getClient());
      return json({
        success: true,
        used_hours: Math.round((usage.usedSeconds / 3600) * 100) / 100,
        limit_hours: Math.round((usage.limitSeconds / 3600) * 100) / 100,
        awake: usage.awake,
      });
    } catch (error: any) {
      return failure(error, "Check DOCLING_URL and DOCLING_API_KEY");
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

    return createMcpHandler(server)(request, env, ctx);
  },
};
