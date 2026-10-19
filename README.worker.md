# Cloudflare Worker: MCP server and Telegram bot

One Worker (`mistral-ocr-telegram`, name kept so the Telegram webhook URL does not move).
Both surfaces call the `docling-api` Worker over HTTP; neither holds a container.

| Path | Surface |
|---|---|
| `/mcp`, `/sse` | MCP server (`src/worker.ts`) |
| `/tg/webhook`, `/setup` | Telegram bot (`src/telegram/`) |

## Configure

`wrangler.toml` vars: `DOCLING_URL` (your docling-api URL), `ADMIN_ID` (your Telegram user id), `OCR_LANG`.

```
npx wrangler secret put DOCLING_API_KEY          # the docling-api Worker's API_KEY
npx wrangler secret put TELEGRAM_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put MCP_AUTH_KEY             # optional, protects /mcp
```

Deploy with `npm run worker:deploy` (or Workers Builds), then register the bot once:

```
curl -X POST "https://mistral-ocr-telegram.<account>.workers.dev/setup?secret=<TELEGRAM_WEBHOOK_SECRET>"
```

The first deploy after the Docling change applies migration `v3`, which deletes the old
`PdfSplitter` class. If Cloudflare still lists the old splitter container application,
remove it with `npx wrangler containers list` then `npx wrangler containers delete <ID>`, so it does not linger.

## MCP client config

```json
{ "mcpServers": { "docling": { "type": "sse", "url": "https://mistral-ocr-telegram.<account>.workers.dev/mcp" } } }
```

If `MCP_AUTH_KEY` is set, add `?auth=<key>` or an `Authorization: Bearer <key>` header.

Tools (sources are a URL or base64, there is no filesystem):

| Tool | Parameters |
|---|---|
| `docling_convert` | `source`, `source_type` (`url`/`base64`), `filename`, `output_format`, `pages`, `clean_output`, `force_ocr`, `ocr_lang`, `images`, `include_hyperlinks` |
| `docling_transcribe` | `source`, `source_type`, `content_type`, `language` |
| `docling_extract_tables` | `source`, `source_type`, `filename`, `pages`, `force_ocr`, `ocr_lang` |
| `docling_clean_markdown` | `content` |
| `docling_usage` | none |

## Telegram bot

Send a document, image, audio, or a link. A panel lets you pick format, images, page range,
forced OCR and a preview, then Send. Files from Telegram are limited to 20 MB (a Telegram rule);
links go straight to the converter and can be up to 200 MB. Audio is limited to 25 MB.

Every conversion spends the owner's container hours, so only `ADMIN_ID` and users the owner
grants with `/allow <user_id>` can run jobs (`/deny <user_id>` revokes). Others can send `/request`.
