# CLAUDE.md

Guidance for Claude Code (claude.ai/code) in this repository.

## Project Overview

Node.js/TypeScript CLI, MCP server and Telegram bot that convert documents, images and audio to text.
Conversion is done by a separate Worker, [`docling-api`](https://github.com/EngDawood/docling), which runs
`docling-serve` in a Cloudflare Container. This repo only holds the clients. The repo and package are still
named `mcp-mistral-ocr`; Mistral was removed in 2.0.0.

| Surface | Entry | Notes |
|---|---|---|
| CLI (`docling`, `ocr`) | `src/cli/index.ts` | Files, directories, URLs. Config in `~/.docling-cli.json`. |
| Local MCP (`docling-mcp`) | `src/index.ts` | stdio. Reads local files. |
| Worker (`mistral-ocr-telegram`) | `src/worker-combined.ts` | Routes `/tg/webhook` and `/setup` to the bot (`src/telegram/`), everything else to the MCP server (`src/worker.ts`). |

Everything talks to `docling-api` through `src/shared/docling.ts`.

## Cost model (read before changing anything that calls the container)

The account is on the $5 Workers Paid plan and the goal is to never pay extra.

- The container is `standard-2` (1 vCPU, 6 GiB). Memory is billed while it is awake and the plan includes
  25 GiB-hours/month, so about 4.17 h of uptime. Cloudflare has no hard spend cap.
- The cap lives in `docling-api` (`DoclingContainer.fetch`): it counts awake seconds and answers `429`
  ("monthly container budget reached") once `MONTHLY_BUDGET_SECONDS` (default 12600) is used. Clients must
  treat that 429 as final, not retry it. `src/shared/docling.ts` does.
- Audio never touches the container: `POST /v1/transcribe` on `docling-api` runs Whisper on Workers AI.
- This Worker holds no container. Do not add one: a second container shares the same 25 GiB-hour pool.

## Git Workflow

| Branch | Purpose |
|--------|---------|
| `main` | Production - only merge from `dev` for releases |
| `dev` | Integration branch - PRs merge here first |
| `feature/*` | Feature branches - create from `dev`, PR to `dev` |

Never push directly to `main` or `dev`. In cloud sessions, work on the branch the session names.

## Layout

```
src/
├── index.ts               Local MCP server (stdio)
├── worker.ts              MCP server module (HTTP/SSE) - not deployed alone
├── worker-combined.ts     Deployed entry: routes between worker.ts and telegram/index.ts
├── mcp/{schemas,handlers}.ts   Local MCP tools (fs access)
├── cli/                   index, args, config, ocr (processFile/processUrl), audio, utils
├── telegram/              api, index, session (Durable Object), jobs, settings, types
└── shared/
    ├── docling.ts         Client: convertUrl, convertBytes, transcribe, getUsage
    ├── convert.ts         finalize, extractTables, extractHyperlinks, parseLangs
    ├── source-url.ts      Share-link normalisation (Drive/Docs/Dropbox/GitHub)
    └── utils.ts           parsePageSpec, markdownToText, cleanMarkdown
test/                      node --test, runs against dist/ (`npm test` builds first)
```

## Talking to docling-serve

`src/shared/docling.ts` uses the asynchronous endpoints: `POST /v1/convert/source/async`, poll
`GET /v1/status/poll/{id}`, then `GET /v1/result/{id}`. The sync endpoint gives up after 120 s and a cold
container needs much of that to load models.

- Files go inline as base64 `file_sources`, URLs as `http_sources`. One request shape, and `page_range` is a
  real JSON array. The Worker request limit is 100 MB, so about 75 MB of file.
- Docling's `page_range` is a contiguous `[first, last]`. A sparse spec like `1,5,9` requests 1-9 and the
  rest is dropped locally, using `md_page_break_placeholder` to find page boundaries.
- Cold starts return 5xx before the service has seen the request, so submit and poll retry 5xx and network
  errors (not 4xx).
- The `http_sources`/`file_sources` body shape comes from docling-serve's docs on 2026-10-13. If a newer
  image rejects it, check `/docs` on the running container.

## Share links

Pasted links are normalised by `normalizeSourceUrl()` in `src/shared/source-url.ts` (Drive, Docs, Slides,
Dropbox, GitHub blob to direct downloads) before they reach Docling. `confirm=t` on Drive downloads is
load-bearing: without it files over ~100 MB return the virus-scan page. Files must be shared "Anyone with
the link". The container, not the Worker, now fetches these URLs.

## Commands

```bash
npm install
npm run build          # tsc -> dist/ (CLI + local MCP)
npm run build:worker   # type-check the Worker and bot (tsc -p tsconfig.worker.json)
npm test               # build + node --test
npm run worker:dev     # wrangler dev (MCP at :8787/mcp)
npm run worker:deploy  # wrangler deploy
```

Worker secrets: `DOCLING_API_KEY`, `TELEGRAM_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, optional `MCP_AUTH_KEY`.
Vars in `wrangler.toml`: `DOCLING_URL`, `ADMIN_ID`, `OCR_LANG`. After the first deploy, register the bot with
`POST /setup?secret=<TELEGRAM_WEBHOOK_SECRET>`.

## Not verified

The code type-checks and the client has unit tests against a mocked service, and the CLI was exercised
against a fake server. These have **not** been run against a real deployment:

- the Docling container image and the exact `docling-serve` request/response shapes;
- Workers AI Whisper with large (15-25 MB) audio, and its Arabic quality;
- Arabic scanned-PDF quality and RTL column order (Mistral's `rtl-layout.ts` repair was removed);
- DOCX hyperlinks (the old path used `mammoth`);
- the Telegram bot and the Worker MCP server end to end.

## Memory (decisions and context from the Docling migration)

Recorded 2026-10-19. Update this section when a decision changes; do not let it drift.

### Decisions the owner made
- **Full replace, not hybrid.** Mistral is gone from every surface. Chosen knowing scanned Arabic OCR is
  likely weaker. If quality turns out unacceptable, the owner decides whether to bring Mistral back as an
  `--engine` option; do not re-add it unasked.
- **Audio on Workers AI Whisper**, not Docling's CPU Whisper, so it does not burn container hours.
- **Hard stop on the budget.** Refuse at about 3.5 h/month rather than allow overage. Target is a $5 bill.
- **Two repos, one boundary.** `EngDawood/docling` owns the container, auth, budget and `/v1/transcribe`.
  This repo only holds clients. Budget logic belongs in `docling`, not here.

### The owner's setup
- Works on Windows (paths like `C:\Users\LEGION\...`); the CLI must keep working with Windows paths.
- Wants to run `docling <url>` and `ocr "<file>"` from the shell, plus MCP and the Telegram bot.
- Documents are often Arabic. Treat Arabic and right-to-left quality as a first-class check, not an edge case.
- The Worker is still named `mistral-ocr-telegram` so the registered Telegram webhook URL stays valid.

### Working preferences
- Be brief. Say so plainly when something is unknown or unverified.
- Ask before assuming when a request is ambiguous. Push back when something is overcomplicated and
  suggest the simpler path.
- No em dashes in written output.
- Do not open a PR unless asked.

### Open items (unverified or undone)
- First real run against a deployed container: confirm the `http_sources`/`file_sources` body, `ocr_lang`
  `["ar","en"]` with the default OCR engine, and cold-start timing.
- Whisper with 15 to 25 MB audio, and its Arabic accuracy.
- Compare scanned Arabic and two-column Arabic output with the old Mistral results.
- DOCX hyperlinks through Docling.
- Delete the old `PdfSplitter` container application in Cloudflare if it still exists.
- `public/index.html` is a stale Mistral page; `package.json` name is still `mcp-mistral-ocr`.
- `docling` repo has no CLAUDE.md yet; the budget invariant is only documented here.
