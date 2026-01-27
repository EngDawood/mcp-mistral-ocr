# Mistral OCR MCP Server (Node.js/TypeScript)

MCP (Model Context Protocol) server for PDF OCR processing using the Mistral AI API.

Node.js/TypeScript implementation designed to be runnable via `npx`.

## Features

- **Process local PDFs**: Extract text/markdown from local PDF files
- **Process URLs**: Download and process PDFs from URLs
- **Process Images**: Direct image OCR (PNG, JPG, etc.)
- **Extract Tables**: Extract tables in HTML or markdown format
- **Structured Data**: Use JSON schemas to extract specific fields
- **Page selection**: Process specific pages (e.g., "1,5-10")
- **Markdown cleaning**: Remove repetitive headers from academic papers
- **Hyperlinks & Images**: Extract hyperlinks and image metadata
- **Arabic/English support**: Optimized for multilingual documents

## Installation

### Via npx (Recommended)

```bash
npx mistral-ocr-mcp
```

### Local Development

```bash
# Clone the repository
git clone https://github.com/yourusername/mistral-mcp-js.git
cd mistral-mcp-js

# Install dependencies
bun install

# Build TypeScript
bun run build

# Run server
bun run start
```

## Configuration

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

2. Add your Mistral API key to `.env`:
   ```
   MISTRAL_API_KEY=your-api-key-here
   ```

3. Get your API key from: https://console.mistral.ai/api-keys

## Usage with Claude Desktop

### Via npx (Production)

Add to your `claude_desktop_config.json`:

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

## Available Tools

| Tool | Description |
|------|-------------|
| `mistral_ocr_process_pdf` | Process a local PDF file |
| `mistral_ocr_process_url` | Download and process PDF from URL |
| `mistral_ocr_process_image` | Process image files (PNG, JPG, etc.) |
| `mistral_ocr_extract_structured` | Extract structured data using JSON schema |
| `mistral_ocr_extract_tables` | Extract tables in HTML or markdown format |
| `mistral_ocr_clean_markdown` | Clean repetitive content from markdown |

## Development

```bash
# Install dependencies
bun install

# Build TypeScript
bun run build

# Run server
bun run start

# Watch mode
bun run dev

# Test with MCP Inspector
npx @modelcontextprotocol/inspector node dist/index.js
```

## License

MIT
