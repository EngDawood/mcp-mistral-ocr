# CLAUDE.telegram.md

Design record and implementation reference for the **Telegram bot surface** of the Mistral OCR project.

**Status:** ✅ Implemented and merged to main (`feature/telegram-bot`, merged 2026-08-29 through 2026-08-31; merged into the single combined Worker deployment on 2026-09-13, see [CLAUDE.md](./CLAUDE.md)). Source: `src/telegram/` (2094 lines at last count — `index.ts`, `session.ts`, `jobs.ts`, `splitter.ts`, `api.ts`, `proxy.ts`, `settings.ts`, `types.ts`). Worker config: `wrangler.toml` (name `mistral-ocr-telegram`, entry point `src/worker-combined.ts` — `wrangler.telegram.toml` was folded into it and no longer exists). Container sidecar: `container/` (Python + `qpdf`).
**Date:** Design drafted August 29, 2026; updated 2026-08-31 to reflect the shipped implementation, including one change to the original design — see "Update: the splitter container" below.
**Companion docs:** [CLAUDE.md](./CLAUDE.md) · [CLAUDE.local.md](./CLAUDE.local.md)

This document originated as a pre-implementation design record (constraints, rejected approaches, settled decisions). That reasoning is kept below because it explains *why* the shipped code looks the way it does — but where the implementation diverged from the original plan, an **Update:** note says so. Don't trust a decision here over the source in `src/telegram/` if the two disagree and there's no note reconciling them.

---

## Why this surface exists

The project already has three surfaces (CLI, local MCP, Worker MCP). All three require the
document to be reachable as **a local path or a public URL**.

The bot exists for the one case none of them cover: **documents that already live inside
Telegram**. A file arrives from another bot or a contact; it has no local path and no public
URL. Today the only way to OCR it is to save it to disk first.

> Rejected motive: "avoid downloading to local storage." That is already solved — the CLI's
> `--url` passes the URL straight to Mistral (`src/cli/ocr.ts:26`), and the Worker MCP has no
> filesystem at all (`src/worker.ts:149`). It is not a reason to build a bot.

---

## Hard constraints (verified against primary docs)

| Constraint | Value | Source |
|---|---|---|
| Telegram bot **file download** | **20 MB** | Bot API `File`: "The maximum file size for downloads is 20 MB" |
| Telegram download link lifetime | at least 1 hour | Bot API `File` |
| Telegram text message | 4096 chars | Bot API |
| `callback_data` | 64 bytes | Bot API `InlineKeyboardButton` |
| `answerCallbackQuery` | **Mandatory** — else the user sees a spinner | Bot API `CallbackQuery` |
| Mistral OCR document | **50 MB, 1000 pages** | Mistral Document AI FAQ |
| Mistral audio transcription | 3 hours; WAV/MP3/FLAC/OGG/M4A/WEBM (bot also passes MPEG/OPUS/MP4, same codecs) | Mistral Speech-to-Text docs (Voxtral Mini Transcribe V2) |
| Worker memory | **128 MB per isolate**, shared across concurrent requests | CF Workers limits |
| Worker CPU | Free **10 ms** · Paid 30 s (raisable to 5 min via `limits.cpu_ms`) | CF Workers limits |
| Worker subrequests | Free **50** · Paid 10,000 | CF Workers limits |
| `ctx.waitUntil()` | **30 seconds** after response | CF Workers limits |
| HTTP-triggered Worker wall time | No limit while client connected | CF Workers limits |
| Durable Object alarm wall time | 15 minutes | CF Workers limits |
| Durable Objects on Free plan | Available (SQLite backend only) | CF pricing |
| Worker filesystem | **None.** Persistence = KV / R2 / D1 / DO | CF docs |

---

## The arithmetic that removed split/merge

An earlier design had the Worker download a file, split it under Mistral's 50 MB limit, OCR each
part, and merge. **That branch can never execute:**

```
Worker can download from Telegram ......  <= 20 MB   (hard Bot API cap)
Split would trigger above ..............   > 50 MB   (Mistral's limit)
20 < 50  ->  unreachable under every possible input
```

The URL path does not rescue it either: there **Mistral** fetches the bytes, so the Worker never
holds them and there is nothing in memory to split. Splitting inside the Worker would mean pulling
50-100 MB into a 128 MB shared isolate, which Cloudflare's own best-practices page says will crash it.

"The Worker splits the file" requires escaping **both** the 20 MB transport cap **and** the 128 MB
memory cap — and anything that has escaped both is not a Worker, it is a VPS running a
self-hosted `telegram-bot-api`. That is a coherent architecture; it is simply a different one.

**Consequence (original design):** size-based splitting is deleted from the design.

**Update: the splitter container.** The implementation adds a third option this section didn't
consider: a **Cloudflare Container sidecar**, not a VPS. `wrangler.toml` declares
`[[containers]] class_name = "PdfSplitter"` (`container/Dockerfile`, Debian + `qpdf` + a stdlib-only
Python HTTP server), and `src/telegram/splitter.ts` is the Worker-side client for it. This resolves
size-based splitting **for the URL path only** — a Container has real memory and disk, so it can
download a large file, split it with `qpdf`, and let the Worker stream the finished parts through
`/f/<token>/...` to Mistral without ever buffering one in the 128 MB isolate. The 20 MB Telegram
**upload** cap analyzed above is untouched and still real: a file attached directly in Telegram is
still capped at 20 MB, because that limit is Telegram's, not the Worker's or the Container's. Only
a *linked* document (a URL, which Mistral or the splitter fetches rather than Telegram delivering)
can exceed 50 MB and trigger a split.

### The one reachable splitting case

Mistral has *two* limits, and only one of them is unreachable. A dense text PDF of 1,200 pages can
be 12 MB — under both size caps, over the **1,000-page** cap. In principle that case needs no PDF
parser: Mistral's OCR accepts a `pages` parameter (already used via `parsePageSpec` -> `ocrParams.pages`),
so "splitting" could mean calling OCR twice on the same document URL with different page ranges and
concatenating the markdown. **Not what shipped** — see Experiment 2 (below) for why the `PdfSplitter`
Container route was taken instead, and note the >1000-page case specifically was never tested either
way.

### Why the existing downloader bot is not a pipeline stage

```
URL -> Mistral directly ...................... 50 MB ceiling
URL -> downloader bot -> Telegram -> OCR bot . 20 MB ceiling
```

Routing a URL through a downloader bot converts the higher-ceiling input into the lower-ceiling
one. It is a strict downgrade, useful only for sources Mistral cannot fetch itself (auth-walled,
JS-rendered, geo-blocked), where 20 MB is accepted as the price of access.

---

## Settled decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | **Accept the 20 MB Telegram-upload cap.** No VPS, no self-hosted Bot API server. | Keeps the Cloudflare Worker. *(Updated: Mistral's 50MB limit is reachable via linked URLs, not direct uploads — a `PdfSplitter` Container sidecar, not a VPS, was added later to split those. See "Update: the splitter container" above.)* |
| 2 | **Inputs:** Telegram attachments <= 20 MB **plus** pasted URLs. | URLs are the escape hatch for larger files, and are nearly free — `src/worker.ts:149` already does it. |
| 3 | **URL handling:** `HEAD` to validate content-type/size, then Mistral fetches. | Catches "Google Drive serves HTML" *before* spending a Mistral call. The Worker never downloads. *(Updated: rather than only catching it, `normalizeSourceUrl` in `src/shared/source-url.ts` now rewrites Drive/Docs/Dropbox/GitHub share links to their direct-download form first — HTML afterwards means the file isn't shared publicly, and the error says so. `validateUrl` falls back to a one-byte ranged `GET` when `HEAD` is refused or answers HTML, and reads the filename from `content-disposition` since a direct-download URL has none in its path.)* |
| 4 | **Runtime:** Worker + **one Durable Object per Telegram user**. | `waitUntil` caps at 30 s — too short for a book. A DO alarm gives 15 min *and* per-user state *and* natural per-user job serialisation, in one binding. |
| 5 | **Byte path:** signed proxy `/f/<hmac>` streaming from Telegram; Mistral fetches that. | The raw Telegram URL contains the **bot token** — handing it to Mistral grants full control of the bot and puts it in their logs. |
| 6 | **Plan:** build for Paid, **degrade loudly** on Free. | Catch the CPU-limit error and reply "document too large for the current plan" rather than failing silently. |
| 7 | **Keys:** env secret for the allowlisted owner (`ADMIN_ID`), `/key` for anyone else, plaintext in the DO. | Owner's key never enters a chat log. Must never fall through to the owner's key for others — see the trap below. |
| 8 | **UX:** file/URL -> one confirm panel (settings as buttons + Send) -> job -> result. | Page ranges and flags are chosen by tapping, not by typing a CLI mini-language into a chat. |
| 9 | **Panel scope:** per-job toggles plus an explicit "save as default" button. | Mirrors the CLI's config-vs-flags priority chain. Persistent-on-every-toggle would silently rewrite every future job. |
| 10 | **Default image mode: `--drop-imgs`.** | The CLI default OCRs *every embedded image as a separate API call*. A 400-figure book = 400 calls and 400 subrequests from one tap of "Send". |
| 11 | **Output: file *and* preview.** `sendDocument` with the `.md`/`.txt`, plus the first N lines inline. | The 4096-char cap means a book is never an inline message; a receipt should not require tapping an attachment. |
| 12 | **DOCX deferred.** v1 rejects it and points at the CLI. | `mammoth`/`turndown` are CLI-only (`src/cli/ocr.ts:4-5`) and likely will not run on Workers. Falling back to Mistral OCR would re-introduce the lost-hyperlinks/broken-tables bug that `processDocx` exists to fix. |
| 13 | **Audio in scope.** | Telegram voice notes are OGG — natively supported by Mistral, no transcoding (which is impossible on Workers anyway). |
| 14 | **Structured extraction out of scope.** | It is an MCP tool, not a CLI feature — no `--schema` flag exists in `src/cli/args.ts`. A JSON schema pasted into a chat bubble is a bad interface regardless. |
| 15 | **Code: additive**, same repo, `src/telegram/` module directory. | Fourth surface, sharing `src/shared/`. **Explicitly not held to CLI feature parity.** |

### Trap to avoid

`src/worker.ts:84` resolves keys as:

```ts
const apiKey = _userApiKey || _env?.MISTRAL_API_KEY || _env?.DEFAULT_MISTRAL_API_KEY;
```

Wiring the bot to this as-is means **every user who has not set a key silently bills the owner's** —
no error, no prompt. The bot must hard-fail with "send /key first" for non-allowlisted users.

---

## Architecture

```
Telegram --webhook--> Worker  /tg/webhook
                        |  (verify X-Telegram-Bot-Api-Secret-Token, ack 200 immediately)
                        v
                   DO: UserSession  user:<telegram_id>
                        |-- storage: api key, saved defaults, pending jobs
                        |-- alarm:   runs the OCR job (15 min wall time)
                        |-- serialises this user's jobs
                        |
                        |--> Telegram getFile ---------> file_path
                        |--> [if linked URL over 50MB] PdfSplitter Container: qpdf split, poll /status
                        |--> Mistral ocr.process { document_url: <worker>/f/<token>/... }
                        |                                        |
                        |    Worker /f/<token> --streams---------+  (Telegram token / Container bytes never leave)
                        |
                        +--> Telegram sendDocument + preview
```

**Bindings (as shipped, `wrangler.toml`):** two Durable Object namespaces (`USER_SESSION` →
`UserSession`, SQLite-backed; `PDF_SPLITTER` → `PdfSplitter`, also the Container binding), one
`[[containers]]` block (`image = "./container/Dockerfile"`, `instance_type = "basic"`), and a
`[limits] cpu_ms = 300000` (Workers Paid only — Free's 10ms/invocation limit still applies
regardless of this setting).

**Environment / secrets:**

| Name | Status |
|---|---|
| `MISTRAL_API_KEY` | present in `.dev.vars` |
| `TELEGRAM_TOKEN` | present in `.dev.vars` |
| `ADMIN_ID` | present in `.dev.vars` — the allowlist |
| `TELEGRAM_WEBHOOK_SECRET` | required in production (`wrangler secret put`) — gates `/tg/webhook` and `POST /setup` |
| `PROXY_SIGNING_KEY` | required in production (`wrangler secret put`) — HMAC for `/f/<hmac>` |

`.dev.vars` is local-development only; production secrets are set via `wrangler secret put` (see [CLAUDE.md](./CLAUDE.md) for the full secret list, which also covers the MCP-only secrets this bot doesn't use).

---

## Request flow

1. **Update arrives** -> verify `X-Telegram-Bot-Api-Secret-Token`; return 200 immediately.
2. **Allowlist check first** (`ADMIN_ID`), before any parsing.
3. **Reject early using metadata Telegram already sent** — `file_size` > 20 MB, unsupported
   `mime_type`, audio `duration` > 60 min. All free; no download required.
4. **URL input:** `HEAD` the link -> confirm it returns a document, not an HTML interstitial.
5. **Show the confirm panel** — current defaults as buttons, page-range choice, Send.
   The "↔️ Columns" button sets the reading order of multi-column pages
   (auto / right-to-left / as scanned) — see "Right-to-Left Column Order" in
   [CLAUDE.md](./CLAUDE.md) for why a two-column Arabic page needs it.
6. **On Send:** the DO sets an alarm; the job runs there.
7. **Progress:** `editMessageText` driven by the existing `onStep` callbacks
   (`processPdf`, `processUrl`, `transcribeAudio` all already take one).
8. **Result:** `sendDocument` plus a plain-text preview.

### Implementation notes

- **Reuse `parseArgs`, do not write a second parser.** `parseArgs(argv, config)` already merges a
  config object with flag overrides in exactly the priority the panel needs.
- **Preview must be plain text — no `parse_mode`.** OCR output is full of unescaped `_`, `*`, `[`,
  `#`; MarkdownV2 rejects the whole message with a 400 on an unbalanced entity, so the preview
  would fail precisely on the messy documents where it matters most. Truncate on a line boundary
  a few hundred chars short of 4096.
- **`callback_data` is 64 bytes** — too small for a config blob. Put a short job id in the button
  and keep the state in the DO.
- **`answerCallbackQuery` is mandatory**, even with no notification text.
- **Fix `AUDIO_EXTENSIONS`** (`src/cli/args.ts:5`): it accepts `.m4a`, `.opus`, `.mp4`, `.mpeg`,
  none of which are on Mistral's documented format list. This is a latent CLI bug today.
- **Error taxonomy:** transient (5xx, timeout) -> retry with backoff; permanent (too many pages,
  unsupported type) -> tell the user. There is no second OCR engine, so "fallback" cannot mean
  another provider.

---

## Out of scope for v1

DOCX/DOC · structured extraction · files > 20 MB via direct Telegram upload ·
directory/batch mode beyond media groups · transcoding of any kind.

*(Size-based splitting was originally listed here too — it shipped, for linked URLs over 50MB,
via the `PdfSplitter` Container. See "Update: the splitter container" above. It remains out of
scope for direct Telegram uploads, which stay capped at 20MB regardless.)*

---

## Experiments — resolved

**1. Does `mammoth` run on Cloudflare Workers?**
Moot rather than answered: the shipped code kept DOCX/DOC deferred either way
(`DEFERRED_EXTENSIONS` in `src/telegram/session.ts`), so decision #12 held without needing this
experiment's result. If a future session wants Workers-side DOCX support, this question is still
open and the experiment as originally described is still the right way to answer it.

**2. Does Mistral reject a >1000-page document regardless of the `pages` parameter?**
Superseded by the Container approach: splitting is done by `qpdf` inside `PdfSplitter`
(`container/server.py`), which slices the source PDF into byte-bounded parts (`SplitRequest.pages`
narrows which pages are considered, `SplitPart` reports each part's actual page range), rather than
by calling Mistral's OCR `pages` parameter twice on an oversized document. Whether Mistral itself
would reject a >1000-page call was never tested, because the shipped design routes around the
question entirely.

---

## Assumptions to overturn if wrong

1. **Source bots hand over files, not URLs** — asked four times, never confirmed. If true, the
   >20 MB URL escape hatch is theoretical and this is a **<= 20 MB tool** in practice for uploads
   that originate from another bot (links pasted by a human are unaffected).
