# mcp-mistral-ocr

MCP (Model Context Protocol) server **and** CLI for OCR and audio transcription using the Mistral AI API.

Supports PDF, DOCX, DOC, PPTX, XLSX, XLS, images (JPEG, PNG, AVIF, TIFF), and audio files. Runs locally via stdio transport, installable with `npx`.

## Quick Start

```bash
npx mcp-mistral-ocr
```

Requires `MISTRAL_API_KEY` in your environment.

## Claude Desktop / Claude Code Setup

Add to your MCP config (`claude_desktop_config.json` or `.mcp.json`):

```json
{
  "mcpServers": {
    "mistral_ocr": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mcp-mistral-ocr"],
      "env": {
        "MISTRAL_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

Get your API key at: <https://console.mistral.ai/api-keys>

## MCP Tools (6)

| Tool | Description |
|------|-------------|
| `mistral_ocr_process_pdf` | Process local document (PDF, DOCX, DOC, PPTX, XLSX, XLS) |
| `mistral_ocr_process_url` | Download and process a document from a URL |
| `mistral_ocr_process_image` | OCR an image file (JPEG, PNG, AVIF, TIFF) |
| `mistral_ocr_extract_structured` | Extract structured data using a JSON schema |
| `mistral_ocr_extract_tables` | Extract tables in HTML or Markdown format |
| `mistral_ocr_clean_markdown` | Remove repetitive headers/footers from OCR output |

All tools return JSON with `success`, `content`, `page_count`, and optional `tables`, `images`, `hyperlinks` fields.

## CLI (`ocr`)

The package also ships an `ocr` CLI for local batch processing:

```bash
# Single file
ocr document.pdf
ocr report.docx --md
ocr scan.png --txt
ocr recording.mp3

# Directory (processes all supported files)
ocr ./docs/

# URL
ocr --url https://example.com/paper.pdf

# Page selection
ocr large.pdf --pages 1,5-10

# Config (persistent per-type defaults)
ocr config set outputFormat md
ocr config pdf set clean true
ocr config show
```

Outputs `.md` (default) or `.txt` (`--txt` flag). Skips files that already have an output.

## Local Development

```bash
git clone https://github.com/EngDawood/mcp-mistral-ocr.git
cd mcp-mistral-ocr
npm install
cp .env.example .env          # add MISTRAL_API_KEY
npm run build
node dist/index.js            # run MCP server
```

Test with MCP Inspector:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

## License

MIT
