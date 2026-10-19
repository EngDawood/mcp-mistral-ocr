#!/usr/bin/env node
/**
 * Docling MCP Server — stdio transport (local version).
 *
 * Tools:
 *   docling_convert         Convert a local file or URL (PDF, Office, image) to text or markdown
 *   docling_transcribe      Transcribe an audio file or URL
 *   docling_extract_tables  Pull the tables out of a document
 *   docling_clean_markdown  Remove repeated headers/footers from markdown
 *   docling_usage           Container time used this month against the budget
 *
 * Set DOCLING_URL and DOCLING_API_KEY as environment variables or in a .env file.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "dotenv";
import {
  ConvertInputSchema,
  TranscribeInputSchema,
  ExtractTablesInputSchema,
  CleanMarkdownInputSchema,
  UsageInputSchema,
} from "./mcp/schemas.js";
import {
  handleConvert,
  handleTranscribe,
  handleExtractTables,
  handleCleanMarkdown,
  handleUsage,
} from "./mcp/handlers.js";

config();

const server = new McpServer({ name: "docling_mcp", version: "2.0.0" });

server.registerTool(
  "docling_convert",
  {
    description: "Convert a document (PDF, DOCX, DOC, PPTX, XLSX, XLS) or image, given as a local path or URL, to text or markdown using Docling. Supports page selection and forced OCR.",
    inputSchema: ConvertInputSchema as any,
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  },
  (params: any) => handleConvert(params)
);

server.registerTool(
  "docling_transcribe",
  {
    description: "Transcribe an audio file (local path or URL, up to 25 MB) to text with Whisper.",
    inputSchema: TranscribeInputSchema as any,
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  },
  (params: any) => handleTranscribe(params)
);

server.registerTool(
  "docling_extract_tables",
  {
    description: "Extract the tables from a document (local path or URL) as markdown. Saves them to a file next to the source.",
    inputSchema: ExtractTablesInputSchema as any,
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  },
  (params: any) => handleExtractTables(params)
);

server.registerTool(
  "docling_clean_markdown",
  {
    description: "Remove repetitive lines (headers/footers appearing 3+ times) from extracted markdown. Preserves page numbers, footnotes, and DOIs.",
    inputSchema: CleanMarkdownInputSchema as any,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  (params: any) => handleCleanMarkdown(params)
);

server.registerTool(
  "docling_usage",
  {
    description: "Show how much of this month's container-time budget has been used.",
    inputSchema: UsageInputSchema as any,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  () => handleUsage()
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Docling MCP server running on stdio");
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
