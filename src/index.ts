#!/usr/bin/env node
/**
 * Mistral OCR MCP Server — stdio transport (local version).
 *
 * Tools:
 *   mistral_ocr_process_pdf        Process a local PDF file
 *   mistral_ocr_process_url        Download and process PDF from URL
 *   mistral_ocr_process_image      Process image file directly
 *   mistral_ocr_extract_structured Extract structured data with JSON schema
 *   mistral_ocr_extract_tables     Extract tables in HTML/markdown format
 *   mistral_ocr_clean_markdown     Clean repetitive content from markdown
 *
 * Set MISTRAL_API_KEY as an environment variable or in a .env file.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "dotenv";
import {
  ProcessPdfInputSchema,
  ProcessUrlInputSchema,
  ProcessImageInputSchema,
  ExtractStructuredInputSchema,
  ExtractTablesInputSchema,
  CleanMarkdownInputSchema,
} from "./mcp/schemas.js";
import {
  handleProcessPdf,
  handleProcessUrl,
  handleProcessImage,
  handleExtractStructured,
  handleExtractTables,
  handleCleanMarkdown,
} from "./mcp/handlers.js";

config();

const server = new McpServer({ name: "mistral_ocr_mcp", version: "1.0.0" });

server.registerTool(
  "mistral_ocr_process_pdf",
  {
    description: "Process a local document file (PDF, DOCX, DOC, PPTX, XLSX, XLS) and extract text or markdown using Mistral OCR. Supports page selection, table extraction, image extraction, and hyperlink extraction.",
    inputSchema: ProcessPdfInputSchema as any,
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  },
  (params: any) => handleProcessPdf(params)
);

server.registerTool(
  "mistral_ocr_process_url",
  {
    description: "Download a PDF from a URL and process it with Mistral OCR. Supports page selection, table/image/hyperlink extraction, and optional local PDF retention.",
    inputSchema: ProcessUrlInputSchema as any,
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  },
  (params: any) => handleProcessUrl(params)
);

server.registerTool(
  "mistral_ocr_process_image",
  {
    description: "Process an image file (PNG, JPG, etc.) with Mistral OCR. Accepts a local file path, URL, or base64-encoded data.",
    inputSchema: ProcessImageInputSchema as any,
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  },
  (params: any) => handleProcessImage(params)
);

server.registerTool(
  "mistral_ocr_extract_structured",
  {
    description: "Extract structured data from a document (PDF, DOCX, DOC, PPTX, XLSX, XLS) or image file using a JSON schema. Returns data matching the provided schema. Limited to 8 pages for annotation.",
    inputSchema: ExtractStructuredInputSchema as any,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  (params: any) => handleExtractStructured(params)
);

server.registerTool(
  "mistral_ocr_extract_tables",
  {
    description: "Extract all tables from a document file (PDF, DOCX, DOC, PPTX, XLSX, XLS) in HTML or markdown format. Saves results to a file alongside the source document.",
    inputSchema: ExtractTablesInputSchema as any,
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  },
  (params: any) => handleExtractTables(params)
);

server.registerTool(
  "mistral_ocr_clean_markdown",
  {
    description: "Remove repetitive lines (headers/footers appearing 3+ times) from OCR-extracted markdown. Preserves page numbers, footnotes, and DOIs.",
    inputSchema: CleanMarkdownInputSchema as any,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  (params: any) => handleCleanMarkdown(params)
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Mistral OCR MCP server running on stdio");
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
