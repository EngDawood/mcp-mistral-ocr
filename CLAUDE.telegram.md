# Telegram bot

Lives in `src/telegram/`, mounted by `src/worker-combined.ts` at `/tg/webhook` and `/setup`.

## Flow

1. `index.ts` checks the webhook secret and forwards each update to that user's Durable Object (`UserSession`).
2. `session.ts` turns a message into a `PendingJob` and shows a settings panel (`settings.ts`).
3. Pressing Send stores a `run:` marker and sets an alarm. The alarm gets 15 minutes of wall time, which
   `waitUntil` (30 s) does not.
4. `jobs.ts` calls `docling-api` through `src/shared/docling.ts` and the result is sent back as a file.

## Inputs

- Telegram files (max 20 MB, a Bot API rule): downloaded in the Worker and sent to Docling as bytes.
- Links: validated (`validateUrl`), normalised (`normalizeSourceUrl`), then passed to Docling as a URL so
  the container downloads them. Capped at 200 MB (`MAX_LINK_BYTES`).
- Audio: sent to `POST /v1/transcribe`. Capped at 25 MB, which is that route's limit.

## Access

Each conversion spends the owner's container hours. `ADMIN_ID` always has access; others need
`/allow <user_id>` from the owner (stored as an `allowed` flag in that user's Durable Object).
`/request` pings the owner. There is no per-user key and no fallback that lets a stranger through.

## Settings panel

Format (md/txt), images (drop/keep/embed), page range, clean, force OCR, preview, save as default.
Page ranges only apply to PDFs.

## Removed in 2.0

The qpdf `PdfSplitter` container and the signed `/f/<token>` proxy existed to get around Mistral's 50 MB
limit and its fetcher being blocked by some hosts. Docling has no such limit and fetches links itself, so
both are gone. `wrangler.toml` migration `v3` deletes the `PdfSplitter` class.
