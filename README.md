# mcp-mistral-ocr (now Docling)

CLI, MCP server and Telegram bot for converting documents, images and audio to text.
The conversion runs on your own [Docling](https://github.com/docling-project/docling)
API, deployed from [EngDawood/docling](https://github.com/EngDawood/docling) to
Cloudflare Containers. Mistral is no longer used.

```
docling https://arxiv.org/pdf/2206.01062
ocr "C:\Users\LEGION\Downloads\Team3_RestaurantManagementDB_Phase0.pdf"
```

## What runs where

| Piece | Where | Cost |
|---|---|---|
| Docling (PDF, Office, images) | Container in the `docling-api` Worker | Counts against the plan's 25 GiB-hours/month; the Worker refuses new work past `MONTHLY_BUDGET_SECONDS` |
| Whisper (audio) | Workers AI, called by `docling-api` | Free up to 10,000 neurons/day (about 3 hours of audio), then $0.0005/min |
| This repo | CLI on your machine, one Worker for the MCP server and the Telegram bot | Workers plan |

## Setup

1. Deploy `docling-api` (see its README) and set its `API_KEY` secret.
2. Put these in `.env` (or your shell):

   ```
   DOCLING_URL=https://docling-api.<your-subdomain>.workers.dev
   DOCLING_API_KEY=<the same key>
   ```
3. `npm install && npm run build && npm link` gives you the `docling`, `ocr` and `docling-mcp` commands.

## CLI

```
docling <file|directory|url>      convert (PDF, DOCX, DOC, PPTX, XLSX, XLS, images)
docling talk.mp3 --language ar    transcribe audio (up to 25 MB)
docling --usage                   container time used this month
docling --help
```

Output is plain text next to the input (`--md` for markdown). Useful flags:
`--pages 1,5-8` (PDF only), `--force-ocr`, `--ocr-lang ar,en`, `--embed-imgs`, `--output <path>`.
Defaults can be saved with `docling config set <key> <value>` (file: `~/.docling-cli.json`).

## MCP (local, stdio)

```json
{
  "mcpServers": {
    "docling": {
      "command": "npx",
      "args": ["-y", "-p", "mcp-mistral-ocr", "docling-mcp"],
      "env": { "DOCLING_URL": "https://docling-api.<your-subdomain>.workers.dev", "DOCLING_API_KEY": "..." }
    }
  }
}
```

Tools: `docling_convert`, `docling_transcribe`, `docling_extract_tables`, `docling_clean_markdown`, `docling_usage`.
The remote version (URL or base64 sources, no filesystem) is described in [README.worker.md](./README.worker.md).

## Differences from the Mistral version

- No JSON-schema extraction (`extract_structured`). Docling does not do it without an LLM.
- No right-to-left column repair. Docling decides reading order itself; check Arabic two-column pages.
- Word files go through Docling, not `mammoth`. Check that hyperlinks survive for your documents.
- Scanned Arabic goes through Docling's OCR (`--ocr-lang ar,en`), which is weaker than Mistral OCR.
- Tool names changed from `mistral_ocr_*` to `docling_*`.
