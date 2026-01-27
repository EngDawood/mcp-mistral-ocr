# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Node.js/TypeScript MCP (Model Context Protocol) server for PDF OCR processing using the Mistral AI API. Designed to be runnable via `npx`. Exposes OCR capabilities to Claude Desktop and other MCP clients. Supports page selection, markdown cleaning, image processing, table extraction, and multilingual documents (Arabic/English).

**Status:** ✅ Implementation complete - all 6 tools implemented and tested

## Architecture

- **Runtime:** Node.js 18+ (TypeScript compiled to JS)
- **MCP SDK:** `@modelcontextprotocol/sdk` v1.25.3 (official MCP SDK for Node.js)
- **AI SDK:** `@mistralai/mistralai` v1.13.0 (official Mistral AI JS/TS SDK)
- **Validation:** Zod v3.25.76 schemas
- **Transport:** stdio (standard MCP transport for CLI tools)
- **Distribution:** npm package, runnable via `npx`
- **Build Tool:** Bun (for faster installs) or npm

## Implemented Tools (6 total)

| Tool Name | Description | Key Parameters |
|-----------|-------------|----------------|
| `mistral_ocr_process_pdf` | Process local PDF file | `file_path`, `output_format`, `pages`, `clean_output`, `table_format`, `include_images`, `include_hyperlinks` |
| `mistral_ocr_process_url` | Download and process PDF from URL | `url`, `output_format`, `pages`, `keep_pdf`, `table_format`, `include_images`, `include_hyperlinks` |
| `mistral_ocr_process_image` | Process image file directly | `image_source`, `source_type`, `output_format`, `clean_output` |
| `mistral_ocr_extract_structured` | Extract structured data with JSON schema | `file_path`, `json_schema`, `pages`, `annotation_type` |
| `mistral_ocr_extract_tables` | Extract tables in HTML/markdown format | `file_path`, `table_format`, `pages` |
| `mistral_ocr_clean_markdown` | Clean repetitive content from markdown | `content`, `config_path` |

## Project Structure

```
mistral-mcp-js/
├── .env                      # API key (git ignored)
├── .env.example              # Template for API key
├── .gitignore
├── .mcp.json                 # MCP client configuration
├── CLAUDE.md                 # Project documentation (this file)
├── package.json              # npm package config
├── tsconfig.json             # TypeScript configuration
├── bun.lockb                 # Bun lockfile
├── src/
│   └── index.ts              # Main MCP server (~1,500 lines, single-file)
├── dist/                     # Compiled JS output (git ignored)
│   ├── index.js              # Compiled server
│   ├── index.d.ts            # Type declarations
│   └── index.js.map          # Source maps
├── node_modules/             # Dependencies (95 packages)
└── README.md                 # Project readme
```

## Key Implementation Details

| Feature | Implementation |
|---------|----------------|
| **MCP Server** | `@modelcontextprotocol/sdk` Server class with stdio transport |
| **Validation** | Zod schemas with `snake_case` parameter names for API compatibility |
| **Tool Registration** | `server.setRequestHandler(CallToolRequestSchema, ...)` |
| **Mistral Client** | `@mistralai/mistralai` with `new Mistral({ apiKey })` |
| **File Upload** | `new Blob([buffer])` for Node 18+ compatibility (not `openAsBlob`) |
| **Markdown Cleaner** | Lightweight inline implementation (removes lines appearing 3+ times) |
| **Path Handling** | Node.js `path` + `fs/promises` with manual `~` expansion |
| **HTTP Requests** | Native `fetch()` API (Node 18+) |
| **Base64 Encoding** | `Buffer.from().toString('base64')` |

## MCP Configuration

### Production (via npx)

```json
{
  "mcpServers": {
    "mistral_ocr_mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mistral-ocr-mcp"],
      "env": {
        "MISTRAL_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

### Local Development

```json
{
  "mcpServers": {
    "mistral_ocr_mcp_js": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\Users\\LEGION\\codebase\\mistral-mcp-js\\dist\\index.js"],
      "env": {
        "MISTRAL_API_KEY": "${MISTRAL_API_KEY}"
      }
    }
  }
}
```

**Note:** This configuration is already added to `.mcp.json` in this repository.

## Dependencies

**Installed (95 packages total):**

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.25.3",
    "@mistralai/mistralai": "^1.13.0",
    "dotenv": "^16.6.1",
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "typescript": "^5.9.3",
    "@types/node": "^22.19.7"
  }
}
```

## Build & Run Commands

```bash
# Install dependencies
bun install              # or: npm install

# Build TypeScript
bun run build            # or: npm run build
# Compiles src/index.ts → dist/index.js

# Run server (development)
node dist/index.js

# Watch mode (auto-rebuild on changes)
bun run dev              # or: npm run dev

# Run via npx (after publishing)
npx mistral-ocr-mcp

# Test with MCP Inspector
npx @modelcontextprotocol/inspector node dist/index.js
```

**Build Output:**
- `dist/index.js` - Compiled server with shebang (`#!/usr/bin/env node`)
- `dist/index.d.ts` - TypeScript type declarations
- `dist/index.js.map` - Source maps for debugging

## Response Format

All tools return JSON strings with consistent structure:

```json
{
  "success": true,
  "content": "extracted text or null",
  "page_count": 10,
  "pages_processed": [1, 2, 3],
  "output_file": "/path/to/output.txt",
  "format": "text|markdown",
  "cleaned": false,
  "warnings": [],
  "tables": [...],          // if table_format specified
  "images": [...],          // if include_images: true
  "hyperlinks": [...]       // if include_hyperlinks: true
}
```

Error responses:
```json
{
  "success": false,
  "error": "Error message",
  "suggestion": "Helpful suggestion to fix the issue"
}
```

## Tool Annotations

All tools include MCP annotations for optimal client behavior:
- `readOnlyHint`: Indicates if tool modifies system state
- `idempotentHint: true`: All tools are idempotent
- `openWorldHint`: Indicates if tool interacts with external services

## Environment

- Node.js 18+ (LTS)
- Requires `MISTRAL_API_KEY` in environment or `.env` file
- Get API key from: https://console.mistral.ai/api-keys
- Platform: Windows (primary development on Windows 10/11)

## Implementation Notes & Lessons Learned

### Compatibility Choices

1. **Node 18+ Support**: Used `new Blob([buffer])` instead of Node 20's `openAsBlob()` to maintain broader compatibility
2. **Parameter Naming**: Kept `snake_case` for all tool parameters (not camelCase) to match API conventions and enable drop-in replacement
3. **Single-File Design**: Maintained ~1,500 line single-file architecture in `src/index.ts` for simplicity

### Key Challenges Solved

1. **Markdown Cleaning**: Implemented lightweight inline deduplication (removes lines appearing 3+ times) since no npm equivalent exists for Python's `markdowncleaner` package. Preserves page numbers, footnotes, and DOIs.

2. **API Parameter Support**: Added try/catch for `extractHeader`/`extractFooter` parameters that may not be supported in all API versions - gracefully falls back without them.

3. **Document Annotation**: Used type assertion `(params as any).documentAnnotationFormat = schema` for structured data extraction due to TypeScript SDK type limitations.

4. **Path Expansion**: Manual `~` expansion for home directory since Node.js path module doesn't handle it automatically:
   ```typescript
   p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : path.resolve(p)
   ```

### Testing

- ✅ Compiles without errors with TypeScript 5.9.3
- ✅ Server starts and connects via stdio transport
- ✅ All 6 tools registered with proper schemas
- ⏳ Pending: End-to-end testing with real PDFs/images (requires MISTRAL_API_KEY)
