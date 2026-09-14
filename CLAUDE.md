# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Node.js/TypeScript MCP (Model Context Protocol) server and CLI for document OCR processing using the Mistral AI API. Available in two surfaces:

1. **Local Version** (`src/index.ts`) - stdio transport MCP server + `mistral-ocr-cli` CLI, runnable via `npx`, supports file system operations
2. **Cloudflare Worker** (`src/worker-combined.ts`) - a single deployed Worker (`mistral-ocr-telegram`) that serves both:
   - the **MCP OCR server** (`src/worker.ts`) - HTTP/SSE transport, no filesystem access, routed at everything except the Telegram paths below
   - the **Telegram bot** (`src/telegram/`) - Durable Object per user + a `qpdf` Container sidecar for splitting documents over Mistral's 50MB limit, routed at `/tg/webhook`, `/f/<token>/<name>`, `/setup`. Handles files that live inside Telegram with no local path or public URL. See [CLAUDE.telegram.md](./CLAUDE.telegram.md).

   These were originally two separate Workers (`mcp-mistral-ocr` and `mistral-ocr-telegram`) and were merged into one deployment so both surfaces share a single domain, secret set and Workers Builds pipeline. `src/worker.ts` and `src/telegram/index.ts` remain independently importable modules — `src/worker-combined.ts` just dispatches between them by path — so either surface could be split back out if ever needed.

**Supported document formats (Mistral OCR API):** PDF, DOCX, DOC, PPTX, XLSX, XLS, and images (JPEG, PNG, AVIF, TIFF)

**Note on DOCX/DOC:** The CLI uses `mammoth` + `turndown` for native Word parsing by default (preserves hyperlinks and tables). Use `--force-ocr` to route through Mistral OCR instead. The Telegram bot defers DOCX/DOC entirely (points users at the CLI).

**Status:** ✅ Local version (6 tools), Worker MCP (5 tools), and Telegram bot all complete, merged to main, and (as of 2026-09-13) merged into a single Worker deployment

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

## Deployment Options

### Local Version (main branch)

- **Runtime:** Node.js 18+ (TypeScript compiled to JS)
- **MCP SDK:** `@modelcontextprotocol/sdk` v1.25.3 (official MCP SDK for Node.js)
- **AI SDK:** `@mistralai/mistralai` v1.13.0 (official Mistral AI JS/TS SDK)
- **Validation:** Zod v3.25.76 schemas
- **Transport:** stdio (standard MCP transport for CLI tools)
- **Distribution:** npm package, runnable via `npx`
- **Build Tool:** pnpm (for faster installs) or npm

### Cloudflare Worker (merged to main; MCP + Telegram bot combined 2026-09-13)

One Worker, one deploy, one set of secrets — routed by path in `src/worker-combined.ts`:

- **Runtime:** Cloudflare Workers + one Durable Object per Telegram user (`UserSession`) + a Container sidecar (`PdfSplitter`, runs `qpdf`)
- **Entry point:** `src/worker-combined.ts` — routes `/tg/webhook`, `/setup`, `/f/<token>/<name>` to the Telegram bot (`src/telegram/index.ts`); everything else (`/mcp`, `/sse`, ...) to the MCP OCR server (`src/worker.ts`)
- **Worker Name:** `mistral-ocr-telegram` (kept from the original Telegram Worker so its registered webhook URL didn't need to move; the old standalone `mcp-mistral-ocr` Worker is retired — MCP clients must be repointed at `https://mistral-ocr-telegram.<account>.workers.dev/mcp`)
- **Config:** `wrangler.toml` (single file; `wrangler.telegram.toml` no longer exists)
- **MCP SDK:** Cloudflare's `agents/mcp` package + `@modelcontextprotocol/sdk`
- **AI SDK:** `@mistralai/mistralai` v1.13.0
- **Validation:** Zod v3.25.76 schemas
- **Transport:** HTTP/SSE (Streamable HTTP transport) for MCP; Telegram webhook (JSON POST) for the bot
- **Distribution:** Deployed via GitHub to Cloudflare Workers Builds
- **Why a Container:** the Worker isolate is capped at 128MB, so a >50MB PDF (Mistral's ceiling) can't be split in-Worker. The container has real memory/disk, splits with `qpdf`, and the Worker only streams finished parts through — see [CLAUDE.telegram.md](./CLAUDE.telegram.md) for the full constraint analysis.
- **Build Tool:** Cloudflare Workers Builds; `wrangler deploy` needs a local Docker daemon (or CI) to build the container image — this now applies to every deploy, including MCP-only changes, since both surfaces ship together
- **Limitations:** No filesystem (MCP: use URLs or base64 instead; Telegram: DOCX/DOC deferred to the CLI); Telegram's 20MB upload cap (URLs bypass it, auto-split above 50MB)

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
├── CLAUDE.telegram.md          # Telegram bot design + implementation record
├── README.md                   # Local version readme
├── README.worker.md            # Worker version readme
├── package.json                # npm package config
├── tsconfig.json               # TypeScript config (local)
├── tsconfig.worker.json        # TypeScript config (worker + telegram, type-check only)
├── wrangler.toml               # Cloudflare Worker config — single combined deploy (MCP + Telegram + container)
├── container/                  # PDF splitter sidecar (Dockerfile + Python/qpdf server)
├── bun.lockb                   # Bun lockfile
├── src/
│   ├── index.ts                # Local MCP server entry point (stdio)
│   ├── worker.ts                # MCP OCR server module (HTTP/SSE) — not deployed standalone
│   ├── worker-combined.ts       # Deployed Worker entry: routes to worker.ts or telegram/index.ts by path
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
│   ├── telegram/                # Telegram bot module (Durable Objects), see CLAUDE.telegram.md
│   │   ├── index.ts             # Fetch handler: webhook, signed file proxy, /setup — mounted by worker-combined.ts
│   │   ├── session.ts           # UserSession Durable Object: state, jobs, alarm-driven runs
│   │   ├── jobs.ts              # OCR job orchestration, error handling/retry
│   │   ├── splitter.ts          # PdfSplitter Container client (qpdf-based, for >50MB PDFs)
│   │   ├── api.ts               # Telegram Bot API client
│   │   ├── proxy.ts             # Signed /f/<token> URL verification
│   │   ├── settings.ts          # Per-user settings panel state
│   │   └── types.ts             # Env + Telegram update types
│   └── shared/
│       ├── utils.ts            # Shared utilities (parsePageSpec, markdownToText, cleanMarkdown, buildSchemaFromJson)
│       └── source-url.ts       # Share-link normalisation (Drive/Docs/Dropbox/GitHub → direct download)
├── test/                       # node --test suite (`npm test`)
├── dist/                       # Compiled JS output (git ignored)
└── node_modules/               # Dependencies
```

## Share Links

Pasted links are normalised before use by `normalizeSourceUrl()` in `src/shared/source-url.ts`,
which every URL-accepting surface calls (Telegram `onUrl`, CLI `processUrl`, MCP
`downloadPdfFromUrl`, Worker `mistral_ocr_process_url`):

| Input | Rewritten to |
|-------|--------------|
| `drive.google.com/file/d/<ID>/view`, `/open?id=`, `/uc?id=` | `drive.usercontent.google.com/download?id=<ID>&export=download&confirm=t` |
| `docs.google.com/document\|spreadsheets/d/<ID>/…` | `…/export?format=pdf` |
| `docs.google.com/presentation/d/<ID>/…` | `…/export/pdf` (path segment, not a query param) |
| `dropbox.com/…?dl=0` | `dl=1` |
| `github.com/o/r/blob/…` | `raw.githubusercontent.com/…` |

**`confirm=t` is load-bearing** — without it, Drive files over ~100 MB return the
virus-scan interstitial as HTML instead of the file.

**Public files only.** A Drive link must be shared "Anyone with the link"; there is
no OAuth. When Google answers with HTML anyway, `validateUrl` reports it as a
sharing problem rather than a malformed link.

Filenames come from the response's `content-disposition` header, since a
direct-download URL carries no name in its path — and the extension is what
Mistral infers document type from.

A third-party resolver API was evaluated and rejected: it only extracted the file
id and rebuilt the same URL, while its filename/size are already in headers we
fetch anyway — and it would have handed a third party a working share credential
for every processed document.

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
      "url": "https://mistral-ocr-telegram.<your-account>.workers.dev/mcp"
    }
  }
}
```

Note: the MCP endpoint now lives on the `mistral-ocr-telegram` Worker (merged with the Telegram bot 2026-09-13). The old standalone `mcp-mistral-ocr` Worker is retired — update any existing config still pointing at it.

**Worker Deployment:**
Deploys automatically via GitHub integration to Cloudflare Workers Builds.

```bash
# Set API key secrets (via Cloudflare dashboard or wrangler)
npx wrangler secret put MISTRAL_API_KEY           # Primary key — shared with the Telegram bot
npx wrangler secret put DEFAULT_MISTRAL_API_KEY   # Fallback key for MCP callers without their own
npx wrangler secret put MISTRAL_API_KEY_BACKUP    # Optional: used on a 429 from the primary key
npx wrangler secret put MCP_AUTH_KEY              # Optional: protect the MCP endpoint
```

**API Key Priority:** `?apiKey=` query param → `MISTRAL_API_KEY` → `DEFAULT_MISTRAL_API_KEY`

**Rate-limit fallback:** whichever key wins that priority is tried first for every OCR call in `src/worker.ts`; on a 429 from Mistral, the call is retried once with `MISTRAL_API_KEY_BACKUP` (if set and different) via `withRateLimitFallback()`.

## Dependencies

**Key dependencies:**

```json
{
  "dependencies": {
    "@cloudflare/containers": "^0.3.7",
    "@modelcontextprotocol/sdk": "^1.12.1",
    "@mistralai/mistralai": "^1.5.0",
    "dotenv": "^16.4.7",
    "mammoth": "^1.12.0",
    "turndown": "^7.2.4",
    "zod": "^3.24.2"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20260702.1",
    "@types/turndown": "^5.0.6",
    "agents": "^0.3.6",
    "typescript": "^5.7.0",
    "@types/node": "^22.0.0",
    "wrangler": "~4.105.0"
  },
  "overrides": {
    "@modelcontextprotocol/sdk": "^1.12.1"
  }
}
```

**Notes:**
- `mammoth` + `turndown`: DOCX/DOC native parsing — preserves hyperlinks and tables (CLI only)
- `@cloudflare/containers`: Backs the Telegram bot's `PdfSplitter` sidecar (Worker-side client for the `qpdf` container)
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

### Cloudflare Worker (MCP + Telegram bot, combined)

Single Worker (`mistral-ocr-telegram`), single `wrangler.toml`, entry point `src/worker-combined.ts`.

```bash
# Install dependencies
npm install

# Type-check (worker.ts + worker-combined.ts + telegram/** + shared/**)
npm run build:worker
# Runs: tsc --project tsconfig.worker.json

# Local development — needs Docker running, since the config always includes
# the PdfSplitter container even for MCP-only changes
npm run worker:dev
# Runs: wrangler dev
# MCP endpoint: http://localhost:8787/mcp
# Telegram webhook (if pointed at a tunnel to this): http://localhost:8787/tg/webhook

# Deploy — also needs Docker locally, or run via Workers Builds CI on the
# production branch (see the [[containers]] comment in wrangler.toml)
npm run worker:deploy
# Runs: wrangler deploy
# Deployed to: https://mistral-ocr-telegram.<account>.workers.dev

# Register the Telegram webhook + bot commands (one-shot, after first deploy
# or after the Worker's URL changes)
curl -X POST "https://mistral-ocr-telegram.<account>.workers.dev/setup?secret=<TELEGRAM_WEBHOOK_SECRET>"

# Secrets (per name, prompts for value — no --config flag needed, wrangler.toml is the only config now)
npx wrangler secret put MISTRAL_API_KEY           # primary key, shared by MCP tools and the bot
npx wrangler secret put DEFAULT_MISTRAL_API_KEY   # MCP only — fallback for callers with no key
npx wrangler secret put MISTRAL_API_KEY_BACKUP    # MCP only — used on a 429 from the primary key
npx wrangler secret put MCP_AUTH_KEY              # MCP only — optional, protects the /mcp endpoint
npx wrangler secret put TELEGRAM_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put PROXY_SIGNING_KEY

# View logs
npx wrangler tail

# Test the MCP side with MCP Inspector (local)
npx @modelcontextprotocol/inspector
# Connect to: http://localhost:8787/mcp
```

**Build Output:**
- `dist/index.js` - Compiled server with shebang (`#!/usr/bin/env node`) — local CLI/stdio version only; the Worker is deployed straight from TypeScript via wrangler's bundler, no `dist/` build step
- `dist/index.d.ts` - TypeScript type declarations
- `dist/index.js.map` - Source maps for debugging

See [CLAUDE.telegram.md](./CLAUDE.telegram.md) for Telegram bot architecture, constraints, and the PDF splitter design.

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
