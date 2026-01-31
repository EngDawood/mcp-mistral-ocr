# Mistral OCR MCP Server - Cloudflare Worker Version

Deploy the Mistral OCR MCP server as a Cloudflare Worker for remote access via HTTP/SSE transport.

## Overview

This is a **remote MCP server** version that runs on Cloudflare's edge network, making it accessible from anywhere via HTTPS. Unlike the local stdio version, this Worker version:

- ✅ Accessible remotely via HTTPS URL
- ✅ No local installation required for clients
- ✅ Runs on Cloudflare's global edge network
- ✅ Supports URL and base64-encoded inputs
- ❌ No filesystem access (use URLs or base64 instead of file paths)

## Supported Tools

| Tool | Description | Input Types |
|------|-------------|-------------|
| `mistral_ocr_process_url` | Process PDF from URL | URL |
| `mistral_ocr_process_image` | Process image | URL, base64 |
| `mistral_ocr_extract_structured` | Extract structured data with JSON schema | URL, base64 |
| `mistral_ocr_extract_tables` | Extract tables in HTML/markdown | URL, base64 |
| `mistral_ocr_clean_markdown` | Clean repetitive markdown content | Text content |

**Note:** File-based operations (`mistral_ocr_process_pdf` with local file paths) are not available in the Worker version due to Cloudflare Workers' lack of filesystem access.

## Prerequisites

1. **Cloudflare Account** - [Sign up for free](https://dash.cloudflare.com/sign-up)
2. **Mistral AI API Key** - [Get from Mistral Console](https://console.mistral.ai/api-keys)
3. **Node.js 18+** - For local development
4. **Wrangler CLI** - Cloudflare's deployment tool (installed via npm)

## Quick Start

### 1. Install Dependencies

```bash
npm install
# or
bun install
```

### 2. Configure API Key

For **local development** (wrangler dev):

```bash
# Copy the example file
cp .dev.vars.example .dev.vars

# Edit .dev.vars and add your API key
# .dev.vars
MISTRAL_API_KEY=your-api-key-here
```

For **production deployment**:

```bash
# Set API key as a secret (encrypted)
npx wrangler secret put MISTRAL_API_KEY
# Enter your API key when prompted
```

### 3. Local Development

Start the Worker locally:

```bash
npm run worker:dev
```

The server will be available at: `http://localhost:8787/mcp`

Test with MCP Inspector:

```bash
npx @modelcontextprotocol/inspector
# In the inspector UI, connect to: http://localhost:8787/mcp
```

### 4. Deploy to Cloudflare

```bash
npm run worker:deploy
```

Your MCP server will be deployed to: `https://mistral-ocr-mcp-worker.<your-account>.workers.dev/mcp`

## Usage with Claude Desktop

Add to your Claude Desktop MCP configuration:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "mistral_ocr_remote": {
      "type": "sse",
      "url": "https://mistral-ocr-mcp-worker.<your-account>.workers.dev/mcp"
    }
  }
}
```

Replace `<your-account>` with your actual Cloudflare account subdomain.

## Configuration

### Wrangler Configuration

Edit `wrangler.toml` to customize:

```toml
name = "mistral-ocr-mcp-worker"
main = "src/worker.ts"
compatibility_date = "2025-01-28"
compatibility_flags = ["nodejs_compat"]
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MISTRAL_API_KEY` | No* | User's Mistral AI API key (set via `wrangler secret put`) |
| `DEFAULT_MISTRAL_API_KEY` | No* | Fallback API key for users without their own key |
| `MCP_AUTH_KEY` | No | Authentication key to protect the Worker endpoint |

*At least one of `MISTRAL_API_KEY` or `DEFAULT_MISTRAL_API_KEY` must be set, or users must pass `?apiKey=` in the URL.

**API Key Priority:**
1. `?apiKey=` query parameter (user-provided per request)
2. `MISTRAL_API_KEY` secret (user's configured key)
3. `DEFAULT_MISTRAL_API_KEY` secret (operator's fallback key)

## Examples

### Process PDF from URL

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

### Process Image (base64)

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

### Extract Structured Data

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

### Clean Markdown

```json
{
  "tool": "mistral_ocr_clean_markdown",
  "arguments": {
    "content": "# Header\n\nPage 1\n\nContent here\n\nPage 1\n\nMore content\n\nPage 1"
  }
}
```

## Deployment Options

### Deploy to Production

```bash
npm run worker:deploy
```

### Deploy to Staging

```bash
npx wrangler deploy --env staging
```

### Custom Domain

Add a custom domain in the Cloudflare dashboard:

1. Go to **Workers & Pages** > Your Worker
2. Click **Settings** > **Triggers**
3. Add **Custom Domain**
4. Enter your domain (e.g., `mcp.example.com`)

Update your Claude Desktop config:

```json
{
  "mcpServers": {
    "mistral_ocr_remote": {
      "type": "sse",
      "url": "https://mcp.example.com/mcp"
    }
  }
}
```

## Monitoring & Logs

View logs in real-time:

```bash
npx wrangler tail
```

View logs in Cloudflare dashboard:

1. Go to **Workers & Pages** > Your Worker
2. Click **Logs** tab
3. View real-time request logs

## Limitations

### Worker-Specific Limitations

| Feature | Local Version | Worker Version |
|---------|---------------|----------------|
| File system access | ✅ Yes | ❌ No |
| Process local PDFs | ✅ Yes | ❌ No (use URL/base64) |
| Process URLs | ✅ Yes | ✅ Yes |
| Process base64 | ✅ Yes | ✅ Yes |
| Save to file | ✅ Yes | ❌ No (returns content only) |
| Output files | ✅ Yes | ❌ No |

### Cloudflare Workers Limits

- **CPU Time**: 50ms (free), 30 seconds (paid)
- **Memory**: 128MB
- **Request Size**: 100MB (paid)
- **Response Size**: Unlimited (streaming)

For large PDFs, consider:
- Using page selection (`pages: "1-10"`)
- Upgrading to Cloudflare Workers Paid plan
- Using the local stdio version for very large files

## Troubleshooting

### "MISTRAL_API_KEY not found"

Make sure you've set the secret:

```bash
npx wrangler secret put MISTRAL_API_KEY
```

### "Failed to download PDF"

Check:
- URL is accessible publicly
- URL points to a valid PDF file
- PDF is not behind authentication

### Worker timeout

For large PDFs:
- Use `pages` parameter to process fewer pages
- Upgrade to Workers Paid plan for longer CPU time
- Consider using the local stdio version

### Type errors during build

Make sure you've installed dev dependencies:

```bash
npm install --save-dev @cloudflare/workers-types wrangler
```

## Development

### Project Structure

```
mistral-mcp-js/
├── src/
│   ├── index.ts          # Local stdio version
│   └── worker.ts         # Cloudflare Worker version
├── wrangler.toml         # Worker configuration
├── tsconfig.json         # TypeScript config (local)
├── tsconfig.worker.json  # TypeScript config (worker)
├── .dev.vars.example     # Example env vars for local dev
└── package.json          # Dependencies and scripts
```

### Build Worker

```bash
# Type-check worker code
npm run build:worker

# Deploy
npm run worker:deploy
```

### Test Locally

```bash
# Start local dev server
npm run worker:dev

# In another terminal, test with curl
curl http://localhost:8787/mcp
```

## Cost Estimation

Cloudflare Workers pricing (as of 2025):

- **Free Tier**: 100,000 requests/day
- **Paid Plan**: $5/month for 10M requests

Mistral AI pricing:
- Check [Mistral Pricing](https://mistral.ai/pricing/) for OCR costs

## Migration from Local Version

If you're currently using the local stdio version, here's how to migrate:

1. **Update tool calls** that use `file_path`:
   ```diff
   - "file_path": "/path/to/local/file.pdf"
   + "source": "https://example.com/file.pdf"
   + "source_type": "url"
   ```

2. **Update Claude Desktop config** from stdio to SSE:
   ```diff
   - "type": "stdio"
   - "command": "npx"
   - "args": ["mistral-ocr-mcp"]
   + "type": "sse"
   + "url": "https://mistral-ocr-mcp-worker.your-account.workers.dev/mcp"
   ```

3. **Remove file-specific parameters**:
   - `save_to_file` - not applicable (no filesystem)
   - `output_dir` - not applicable
   - `keep_pdf` - not applicable

## Support

- **Issues**: [GitHub Issues](https://github.com/your-username/mistral-mcp-js/issues)
- **Cloudflare Docs**: [Workers Documentation](https://developers.cloudflare.com/workers/)
- **Mistral Docs**: [Mistral AI Documentation](https://docs.mistral.ai/)

## License

MIT
