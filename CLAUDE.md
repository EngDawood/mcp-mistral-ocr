# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Node.js/TypeScript MCP (Model Context Protocol) server and CLI for document OCR processing using the Mistral AI API. Available in two versions:

1. **Local Version** (`src/index.ts`) - stdio transport MCP server + `mistral-ocr-cli` CLI, runnable via `npx`, supports file system operations
2. **Cloudflare Worker Version** (`src/worker.ts`) - HTTP/SSE transport, deployed to Cloudflare's edge network, no filesystem access

**Supported document formats (Mistral OCR API):** PDF, DOCX, DOC, PPTX, XLSX, XLS, and images (JPEG, PNG, AVIF, TIFF)

**Note on DOCX/DOC:** The CLI uses `mammoth` + `turndown` for native Word parsing by default (preserves hyperlinks and tables). Use `--force-ocr` to route through Mistral OCR instead.

**Status:** ✅ Both versions complete and merged to main - Local version (6 tools) + Worker version (5 tools)

## Git Workflow

**IMPORTANT:** Follow this branching strategy:

| Branch | Purpose |
|--------|---------|
| `main` | Production - only merge from `dev` for releases |
| `dev` | Integration branch - PRs merge here first |
| `feature/*` | Feature branches - create from `dev`, PR to `dev` |

**Rules:**
- ❌ **NEVER push directly to `main`**
- ❌ **NEVER push directly to `dev`**
- ✅ Create feature branches from `dev`
- ✅ Create PRs to merge into `dev`
- ✅ Merge `dev` → `main` only for production releases

**Workflow:**
```bash
# Start new feature
git checkout dev && git pull
git checkout -b feature/my-feature

# Work on feature, then push
git push -u origin feature/my-feature

# Create PR to dev (not main!)
gh pr create --base dev
```

## Two Deployment Options

### Local Version (main branch)

- **Runtime:** Node.js 18+ (TypeScript compiled to JS)
- **MCP SDK:** `@modelcontextprotocol/sdk` v1.25.3 (official MCP SDK for Node.js)
- **AI SDK:** `@mistralai/mistralai` v1.13.0 (official Mistral AI JS/TS SDK)
- **Validation:** Zod v3.25.76 schemas
- **Transport:** stdio (standard MCP transport for CLI tools)
- **Distribution:** npm package, runnable via `npx`
- **Build Tool:** pnpm (for faster installs) or npm

### Cloudflare Worker Version (merged to main)

- **Runtime:** Cloudflare Workers (edge compute)
- **MCP SDK:** Cloudflare's `agents/mcp` package + `@modelcontextprotocol/sdk`
- **AI SDK:** `@mistralai/mistralai` v1.13.0
- **Validation:** Zod v3.25.76 schemas
- **Transport:** HTTP/SSE (Streamable HTTP transport)
- **Distribution:** Deployed via GitHub to Cloudflare Workers Builds
- **Worker Name:** `mcp-mistral-ocr`
- **Build Tool:** Cloudflare Workers Builds (automatic via GitHub integration)
- **Limitations:** No filesystem access (use URLs or base64 instead)

## Implemented Tools

### Local Version (6 tools)

| Tool Name | Description | Key Parameters |
|-----------|-------------|----------------|
| `mistral_ocr_process_pdf` | Process local document file (PDF, DOCX, DOC, PPTX, XLSX, XLS) | `file_path`, `output_format`, `pages`, `clean_output`, `table_format`, `include_images`, `include_hyperlinks` |
| `mistral_ocr_process_url` | Download and process document from URL | `url`, `output_format`, `pages`, `keep_pdf`, `table_format`, `include_images`, `include_hyperlinks` |
| `mistral_ocr_process_image` | Process image file directly | `image_source`, `source_type`, `output_format`, `clean_output` |
| `mistral_ocr_extract_structured` | Extract structured data with JSON schema | `file_path`, `json_schema`, `pages`, `annotation_type` |
| `mistral_ocr_extract_tables` | Extract tables in HTML/markdown format | `file_path`, `table_format`, `pages` |
| `mistral_ocr_clean_markdown` | Clean repetitive content from markdown | `content`, `config_path` |

### Worker Version (5 tools)

| Tool Name | Description | Key Parameters | Notes |
|-----------|-------------|----------------|-------|
| `mistral_ocr_process_url` | Process PDF from URL | `url`, `output_format`, `pages`, `clean_output`, `table_format`, `include_images`, `include_hyperlinks` | No `keep_pdf` (no filesystem) |
| `mistral_ocr_process_image` | Process image (URL or base64) | `image_source`, `source_type`, `output_format`, `clean_output` | `source_type`: "url" or "base64" only |
| `mistral_ocr_extract_structured` | Extract structured data | `source`, `source_type`, `json_schema`, `pages`, `annotation_type` | Uses `source`/`source_type` instead of `file_path` |
| `mistral_ocr_extract_tables` | Extract tables | `source`, `source_type`, `table_format`, `pages` | Uses `source`/`source_type` instead of `file_path` |
| `mistral_ocr_clean_markdown` | Clean repetitive markdown | `content` | Stateless, works identically |

## Project Structure

```
mistral-mcp-js/
├── .env                        # API key (git ignored)
├── .env.example                # Template for API key
├── .dev.vars.example           # Worker local dev vars template
├── .gitignore
├── .mcp.json                   # MCP client configuration
├── CLAUDE.md                   # Project documentation (this file)
├── README.md                   # Local version readme
├── README.worker.md            # Worker version readme
├── package.json                # npm package config
├── tsconfig.json               # TypeScript config (local)
├── tsconfig.worker.json        # TypeScript config (worker)
├── wrangler.toml               # Cloudflare Worker config
├── bun.lockb                   # Bun lockfile
├── src/
│   ├── index.ts                # Local MCP server entry point (stdio)
│   ├── worker.ts               # Cloudflare Worker MCP server (HTTP/SSE)
│   ├── mcp/
│   │   ├── schemas.ts          # Zod validation schemas for all 6 MCP tools
│   │   ├── handlers.ts         # MCP tool handler implementations
│   │   └── ocr-core.ts         # Core OCR logic (processPdfOcr, processImageOcr, etc.)
│   ├── cli/
│   │   ├── index.ts            # CLI entry point (mistral-ocr-cli)
│   │   ├── args.ts             # Argument parsing + ParsedConfig interface
│   │   ├── ocr.ts              # OCR processing functions (processPdf, processDocx, processImage, processUrl)
│   │   ├── audio.ts            # Audio transcription + findFiles (directory scanner)
│   │   ├── utils.ts            # CLI utilities (isDocumentFile, isImageFile, expandPath, etc.)
│   │   └── config.ts           # Config management (~/.mistral-ocr.json, per-type settings)
│   └── shared/
│       └── utils.ts            # Shared utilities (parsePageSpec, markdownToText, cleanMarkdown, buildSchemaFromJson)
├── dist/                       # Compiled JS output (git ignored)
└── node_modules/               # Dependencies
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

### Cloudflare Worker (Remote)

```json
{
  "mcpServers": {
    "mistral_ocr_worker": {
      "type": "sse",
      "url": "https://mcp-mistral-ocr.<your-account>.workers.dev/mcp"
    }
  }
}
```

**Worker Deployment:**
Deploys automatically via GitHub integration to Cloudflare Workers Builds.

```bash
# Set API key secrets (via Cloudflare dashboard or wrangler)
npx wrangler secret put MISTRAL_API_KEY           # User's API key
npx wrangler secret put DEFAULT_MISTRAL_API_KEY   # Fallback key for users without their own
npx wrangler secret put MCP_AUTH_KEY              # Optional: protect endpoint access
```

**API Key Priority:** `?apiKey=` query param → `MISTRAL_API_KEY` → `DEFAULT_MISTRAL_API_KEY`

## Dependencies

**Key dependencies:**

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.1",
    "@mistralai/mistralai": "^1.5.0",
    "agents": "^0.3.6",
    "dotenv": "^16.4.7",
    "mammoth": "^1.x",
    "turndown": "^7.x",
    "zod": "^3.24.2"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20260127.0",
    "@types/turndown": "^5.x",
    "typescript": "^5.7.0",
    "@types/node": "^22.0.0",
    "wrangler": "^3.103.0"
  },
  "overrides": {
    "@modelcontextprotocol/sdk": "^1.12.1"
  }
}
```

**Notes:**
- `mammoth` + `turndown`: DOCX/DOC native parsing — preserves hyperlinks and tables (CLI only)
- `overrides`: Forces a single version of `@modelcontextprotocol/sdk` to resolve type conflicts

## Build & Run Commands

### Local Version

```bash
# Install dependencies
npm install              # or: npm install

# Build TypeScript
npm run build            # or: npm run build
# Compiles src/index.ts → dist/index.js

# Run server (development)
node dist/index.js

# Watch mode (auto-rebuild on changes)
npm run dev              # or: npm run dev

# Run via npx (after publishing)
npx mistral-ocr-mcp

# Test with MCP Inspector
npx @modelcontextprotocol/inspector node dist/index.js
```

### Cloudflare Worker Version

```bash
# Install dependencies
npm install

# Local development (with .dev.vars)
npm run worker:dev
# Server runs at: http://localhost:8787/mcp

# Production deploys automatically via GitHub → Cloudflare Workers Builds
# Deployed to: https://mcp-mistral-ocr.<account>.workers.dev/mcp

# Set API key secret (via Cloudflare dashboard or wrangler)
npx wrangler secret put MISTRAL_API_KEY

# View logs
npx wrangler tail

# Test with MCP Inspector (local)
npx @modelcontextprotocol/inspector
# Connect to: http://localhost:8787/mcp
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
2. **Parameter Naming**: Kept `snake_case` for all tool parameters (not camelCase) to match API conventions
3. **Modular Architecture**: Code split into `src/mcp/`, `src/cli/`, `src/shared/` modules for maintainability

### Key Challenges Solved

1. **DOCX Hyperlinks & Tables**: Mistral OCR processes DOCX visually and loses structural data. Fixed by routing DOCX/DOC through `mammoth` (Word XML parser) + `turndown` (HTML→markdown) in the CLI. Use `--force-ocr` to opt back to Mistral OCR.

2. **Multi-format Document Support**: Added `SUPPORTED_DOC_EXTENSIONS = [".pdf", ".docx", ".doc", ".pptx", ".xlsx", ".xls"]` in MCP handlers. All document types use `client.files.upload()` — Mistral infers type from filename extension.

3. **CLI Config System**: Per-user persistent defaults at `~/.mistral-ocr.json`. Supports global and per-type (`pdf`, `docx`, `img`, `audio`) settings. Priority: built-in defaults → global config → type config → CLI flags.

4. **Markdown Cleaning**: Lightweight inline deduplication (removes lines appearing 3+ times). Preserves page numbers, footnotes, DOIs.

5. **API Parameter Support**: Added try/catch for `extractHeader`/`extractFooter` — gracefully falls back without them if API version doesn't support them.

6. **Document Annotation**: Used type assertion `(params as any).documentAnnotationFormat = schema` for structured extraction due to TypeScript SDK type limitations.

7. **Path Expansion**: Manual `~` expansion since Node.js `path.resolve()` doesn't handle it:
   ```typescript
   p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : path.resolve(p)
   ```

### Testing

**Local Version:**
- ✅ Compiles without errors with TypeScript 5.9.3
- ✅ Server starts and connects via stdio transport
- ✅ All 6 tools registered with proper schemas
- ⏳ Pending: End-to-end testing with real PDFs/images (requires MISTRAL_API_KEY)

**Worker Version:**
- ✅ Compiles without errors with TypeScript 5.9.3
- ✅ Worker entry point exports proper fetch handler
- ✅ All 5 tools registered with proper schemas
- ✅ HTTP/SSE transport configured via createMcpHandler
- ✅ Merged to main branch
- ✅ GitHub → Cloudflare Workers Builds integration configured
- ⏳ Pending: End-to-end testing with real PDFs/images
