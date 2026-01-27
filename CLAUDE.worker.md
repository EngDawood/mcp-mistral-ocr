# CLAUDE.worker.md

Local memory for the Cloudflare Worker version of Mistral OCR MCP Server.

## Branch Information

**Branch Name:** cloudflare-worker
**Created:** January 28, 2026
**Status:** ✅ Complete and ready for deployment
**Latest Commit:** `50bdfd4` - "feat: Add Cloudflare Worker version with HTTP/SSE transport"

## Implementation Status

**Worker Version:** ✅ Complete (5 tools)

- ✅ `mistral_ocr_process_url` - Process PDFs from URLs (no keep_pdf parameter)
- ✅ `mistral_ocr_process_image` - Process images (URL/base64 only)
- ✅ `mistral_ocr_extract_structured` - Extract structured data (source/source_type parameters)
- ✅ `mistral_ocr_extract_tables` - Extract tables (source/source_type parameters)
- ✅ `mistral_ocr_clean_markdown` - Clean repetitive markdown content

**Removed from Local Version:**
- ❌ `mistral_ocr_process_pdf` - Not compatible with Workers (no filesystem access)

## Architecture Overview

### Transport Mechanism
- **Type:** HTTP/SSE (Server-Sent Events)
- **Handler:** `createMcpHandler` from `agents/mcp` package
- **Server Class:** `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`
- **Endpoint:** `/mcp` path on Worker URL

### Environment Variables
- **Local Dev:** Uses `.dev.vars` file (git ignored)
- **Production:** Uses Wrangler secrets (`wrangler secret put MISTRAL_API_KEY`)
- **Access:** Via `env` parameter passed to tool handlers

### Key Constraints
- **No Filesystem:** Workers have no access to local files
- **Input Types:** URL and base64 only (no file paths)
- **CPU Time:** 50ms (free), 30 seconds (paid)
- **Memory:** 128MB limit
- **Request Size:** 100MB (paid plan)

## Files Created

### 1. src/worker.ts (~800 lines)
**Purpose:** Main Worker entry point with HTTP/SSE transport

**Key Sections:**
```typescript
// Imports
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import Mistral from "@mistralai/mistralai";

// Modified getApiKey to accept env parameter
function getApiKey(env: any): string {
  const apiKey = env.MISTRAL_API_KEY;
  if (!apiKey) {
    throw new Error("MISTRAL_API_KEY not found in Worker environment");
  }
  return apiKey;
}

// Export Worker fetch handler
export default {
  fetch: (request: Request, env: any, ctx: any) => {
    return createMcpHandler(server)(request, env, ctx);
  },
};
```

**Schema Changes:**
- `ProcessUrlInputSchema`: Removed `keep_pdf` parameter (no filesystem)
- `ProcessImageInputSchema`: Removed "file" from `source_type` enum
- `ExtractStructuredInputSchema`: Changed `file_path` to `source`/`source_type`
- `ExtractTablesInputSchema`: Changed `file_path` to `source`/`source_type`

**Tool Handler Changes:**
- All tools access API key via: `getApiKey((extra as any).env)`
- Removed all filesystem operations (fs.writeFile, fs.unlink, etc.)
- Removed path resolution and file saving logic
- Process URL and base64 inputs only

### 2. wrangler.toml
**Purpose:** Cloudflare Worker configuration

```toml
name = "mistral-ocr-mcp-worker"
main = "src/worker.ts"
compatibility_date = "2025-01-28"
compatibility_flags = ["nodejs_compat"]

[env.production]
name = "mistral-ocr-mcp-worker"

[env.staging]
name = "mistral-ocr-mcp-worker-staging"
```

**Critical Settings:**
- `nodejs_compat` flag: Enables Node.js API subset (Buffer, Blob, fetch enhancements)
- `main`: Points to Worker entry point (src/worker.ts)
- `compatibility_date`: Set to latest (2025-01-28)

### 3. tsconfig.worker.json
**Purpose:** TypeScript configuration for Worker build

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "types": ["@cloudflare/workers-types"],
    "lib": ["ES2022"],
    "noEmit": true
  },
  "include": ["src/worker.ts"],
  "exclude": ["node_modules", "dist", "src/index.ts"]
}
```

**Key Differences from Local Config:**
- `moduleResolution: "Bundler"` instead of "Node16"
- Includes `@cloudflare/workers-types` for Worker APIs
- `noEmit: true` (Wrangler handles bundling)
- Excludes local version (src/index.ts)

### 4. README.worker.md
**Purpose:** Comprehensive deployment and usage guide

**Contents:**
- Overview and comparison with local version
- Prerequisites (Cloudflare account, Mistral API key)
- Quick start guide (install, configure, dev, deploy)
- Usage examples for all 5 tools
- Claude Desktop MCP configuration
- Deployment options (production, staging, custom domain)
- Monitoring and logs instructions
- Limitations comparison table
- Troubleshooting guide
- Migration guide from local version

### 5. .dev.vars.example
**Purpose:** Template for local Worker development

```
MISTRAL_API_KEY=your-mistral-api-key-here
```

**Usage:**
```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars with actual API key
npm run worker:dev
```

## Modified Files

### 1. package.json
**Added Dependencies:**
```json
"dependencies": {
  "agents": "^0.0.1"  // Cloudflare's MCP handler
}
```

**Added Dev Dependencies:**
```json
"devDependencies": {
  "@cloudflare/workers-types": "^4.20250117.0",
  "wrangler": "^3.103.0"
}
```

**Added Scripts:**
```json
"scripts": {
  "build:worker": "tsc --project tsconfig.worker.json",
  "worker:dev": "wrangler dev",
  "worker:deploy": "wrangler deploy"
}
```

### 2. .gitignore
**Added Exclusions:**
```
.dev.vars
.wrangler/
```

### 3. CLAUDE.md
**Updated Sections:**
- Added Worker version to project overview
- Added Worker tools comparison table
- Added Worker MCP configuration examples
- Added Worker build commands
- Updated dependencies list
- Updated project structure

## Deployment Workflow

### Local Development
```bash
# 1. Install dependencies
npm install

# 2. Copy environment template
cp .dev.vars.example .dev.vars

# 3. Edit .dev.vars and add MISTRAL_API_KEY
# .dev.vars:
# MISTRAL_API_KEY=your-actual-key

# 4. Start local dev server
npm run worker:dev

# 5. Test with MCP Inspector
npx @modelcontextprotocol/inspector
# Connect to: http://localhost:8787/mcp
```

### Production Deployment
```bash
# 1. Set production API key (one-time, encrypted)
npx wrangler secret put MISTRAL_API_KEY
# Enter your API key when prompted

# 2. Deploy to Cloudflare
npm run worker:deploy

# 3. Note your deployment URL
# https://mistral-ocr-mcp-worker.<your-account>.workers.dev/mcp
```

### Staging Deployment
```bash
# Deploy to staging environment
npx wrangler deploy --env staging
# https://mistral-ocr-mcp-worker-staging.<your-account>.workers.dev/mcp
```

### Custom Domain Setup
1. Go to Cloudflare Dashboard → Workers & Pages → Your Worker
2. Click Settings → Triggers
3. Add Custom Domain (e.g., `mcp.example.com`)
4. Update Claude Desktop config with custom domain URL

## Claude Desktop Configuration

### Remote Worker Connection
```json
{
  "mcpServers": {
    "mistral_ocr_worker": {
      "type": "sse",
      "url": "https://mistral-ocr-mcp-worker.<your-account>.workers.dev/mcp"
    }
  }
}
```

**Config Locations:**
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

**Key Differences from Local Config:**
- `type: "sse"` instead of `type: "stdio"`
- `url` parameter instead of `command`/`args`
- No `env` parameter (API key stored as Wrangler secret)

## Tool Usage Examples

### 1. Process PDF from URL
```json
{
  "tool": "mistral_ocr_process_url",
  "arguments": {
    "url": "https://example.com/document.pdf",
    "output_format": "markdown",
    "pages": "1-5",
    "clean_output": true,
    "table_format": "html"
  }
}
```

### 2. Process Image (Base64)
```json
{
  "tool": "mistral_ocr_process_image",
  "arguments": {
    "image_source": "data:image/png;base64,iVBORw0KGgoAAAANS...",
    "source_type": "base64",
    "output_format": "text",
    "clean_output": false
  }
}
```

### 3. Process Image (URL)
```json
{
  "tool": "mistral_ocr_process_image",
  "arguments": {
    "image_source": "https://example.com/image.png",
    "source_type": "url",
    "output_format": "markdown",
    "clean_output": true
  }
}
```

### 4. Extract Structured Data
```json
{
  "tool": "mistral_ocr_extract_structured",
  "arguments": {
    "source": "https://example.com/invoice.pdf",
    "source_type": "url",
    "json_schema": "{\"type\": \"object\", \"properties\": {\"total\": {\"type\": \"number\"}, \"date\": {\"type\": \"string\"}}}",
    "annotation_type": "document"
  }
}
```

### 5. Extract Tables
```json
{
  "tool": "mistral_ocr_extract_tables",
  "arguments": {
    "source": "https://example.com/data.pdf",
    "source_type": "url",
    "table_format": "html",
    "pages": "1-10"
  }
}
```

### 6. Clean Markdown
```json
{
  "tool": "mistral_ocr_clean_markdown",
  "arguments": {
    "content": "# Header\n\nPage 1\n\nContent here\n\nPage 1\n\nMore content\n\nPage 1"
  }
}
```

## Key Differences: Local vs Worker

| Feature | Local Version | Worker Version |
|---------|---------------|----------------|
| **Transport** | stdio | HTTP/SSE |
| **Tools** | 6 tools | 5 tools |
| **File System** | ✅ Yes | ❌ No |
| **Input Types** | File paths, URLs, base64 | URLs, base64 only |
| **Deployment** | npx or local binary | Cloudflare edge network |
| **API Key** | .env file | wrangler secret |
| **Access** | Local only | Remote (HTTPS) |
| **File Saving** | ✅ Yes (output_file) | ❌ No (content only) |
| **keep_pdf Parameter** | ✅ Yes | ❌ No |
| **Page Selection** | ✅ Yes (pages param) | ✅ Yes (pages param) |
| **Clean Output** | ✅ Yes | ✅ Yes |
| **Table Extraction** | ✅ Yes | ✅ Yes |
| **Structured Data** | ✅ Yes | ✅ Yes |

## Common Development Tasks

### Type-Check Worker Code
```bash
npm run build:worker
# Runs: tsc --project tsconfig.worker.json
```

### View Real-Time Logs
```bash
npx wrangler tail
# Streams logs from production Worker
```

### View Logs in Dashboard
1. Go to Cloudflare Dashboard
2. Workers & Pages → Your Worker
3. Logs tab

### Test Locally with curl
```bash
# Start local server
npm run worker:dev

# In another terminal, test endpoint
curl http://localhost:8787/mcp
```

### Debug Issues
1. Check Wrangler logs: `npx wrangler tail`
2. Test locally: `npm run worker:dev`
3. Use MCP Inspector for interactive testing
4. Check Worker dashboard for errors

## Known Limitations

### 1. No Filesystem Access
**Impact:** Cannot save files or read local PDFs
**Workaround:** Use URLs or base64-encoded inputs

### 2. CPU Time Limits
**Impact:** Large PDFs may timeout on free plan
**Workaround:**
- Use `pages` parameter to process fewer pages
- Upgrade to Workers Paid plan (30s CPU time)
- Use local version for very large files

### 3. No keep_pdf Parameter
**Impact:** Downloaded PDFs cannot be saved
**Workaround:** Not applicable - Worker design choice

### 4. Memory Limits (128MB)
**Impact:** Very large PDF buffers may hit limit
**Workaround:**
- Process fewer pages at once
- Use Cloudflare Workers Paid plan

### 5. Cold Start Latency
**Impact:** First request may be slower (~200-500ms)
**Workaround:** Expected behavior, subsequent requests are fast

## Troubleshooting

### "MISTRAL_API_KEY not found"
**Cause:** API key not set as Wrangler secret
**Fix:**
```bash
npx wrangler secret put MISTRAL_API_KEY
# Enter your API key when prompted
```

### "Failed to download PDF"
**Cause:** URL not accessible or behind authentication
**Fix:**
- Verify URL is publicly accessible
- Ensure URL points to valid PDF
- Check PDF is not behind authentication

### Worker Timeout
**Cause:** Large PDF processing exceeds CPU time limit
**Fix:**
- Use `pages` parameter to process fewer pages
- Upgrade to Workers Paid plan
- Use local version for large files

### Type Errors During Build
**Cause:** Missing Worker types or dependencies
**Fix:**
```bash
npm install --save-dev @cloudflare/workers-types wrangler
npm run build:worker
```

### Cannot Connect to http://localhost:8787
**Cause:** Wrangler dev server not running
**Fix:**
```bash
# Make sure .dev.vars exists with API key
npm run worker:dev
```

## Cost Estimation

### Cloudflare Workers Pricing (2025)
- **Free Tier:** 100,000 requests/day
- **Paid Plan:** $5/month for 10M requests
- **Paid Benefits:** 30s CPU time, faster execution

### Mistral AI Pricing
- Check current OCR pricing at: https://mistral.ai/pricing/
- Pricing depends on:
  - Number of pages processed
  - Document complexity
  - API model version

### Estimated Monthly Cost (Example)
**Scenario:** 10,000 PDF pages/month, 5 pages per request

- Cloudflare: Free (2,000 requests < 100k limit)
- Mistral OCR: ~$X (check current pricing)
- **Total:** Mistral API costs only

## Migration from Local Version

If migrating from local stdio version:

### 1. Update Tool Calls
```diff
- "file_path": "/path/to/local/file.pdf"
+ "source": "https://example.com/file.pdf"
+ "source_type": "url"
```

### 2. Update MCP Configuration
```diff
{
  "mcpServers": {
    "mistral_ocr_mcp": {
-     "type": "stdio",
-     "command": "npx",
-     "args": ["-y", "mistral-ocr-mcp"],
-     "env": {
-       "MISTRAL_API_KEY": "your-api-key"
-     }
+     "type": "sse",
+     "url": "https://mistral-ocr-mcp-worker.<account>.workers.dev/mcp"
    }
  }
}
```

### 3. Remove File-Specific Parameters
```diff
- "keep_pdf": true
- "output_dir": "/path/to/dir"
- "save_to_file": true
```

### 4. Handle Outputs Differently
**Local:** Returns `output_file` path
**Worker:** Returns `content` directly (no file saved)

## Testing Checklist

- ✅ TypeScript compilation (no errors)
- ✅ Worker exports proper fetch handler
- ✅ All 5 tools registered with annotations
- ✅ HTTP/SSE transport configured via createMcpHandler
- ⏳ Local testing with `wrangler dev`
- ⏳ MCP Inspector connection test
- ⏳ Production deployment to Cloudflare
- ⏳ End-to-end URL PDF processing
- ⏳ End-to-end base64 image processing
- ⏳ Table extraction test
- ⏳ Structured data extraction test
- ⏳ Markdown cleaning test

## Next Steps

1. **Local Testing:**
   ```bash
   npm install
   cp .dev.vars.example .dev.vars
   # Edit .dev.vars with API key
   npm run worker:dev
   npx @modelcontextprotocol/inspector
   # Connect to: http://localhost:8787/mcp
   ```

2. **Production Deployment:**
   ```bash
   npx wrangler secret put MISTRAL_API_KEY
   npm run worker:deploy
   ```

3. **Connect to Claude Desktop:**
   - Add Worker URL to MCP config
   - Test with real PDF/image processing

4. **Optional: Merge to Main:**
   ```bash
   git checkout main
   git merge cloudflare-worker
   # Or keep branches separate for different deployment targets
   ```

## Last Updated

**Date:** January 28, 2026
**By:** Claude Code (claude.ai/code)
**Status:** Worker version complete and ready for deployment
**Branch:** cloudflare-worker
**Commit:** 50bdfd4
