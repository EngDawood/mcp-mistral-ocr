/**
 * UserSession — one Durable Object per Telegram user.
 *
 * Why a DO rather than `ctx.waitUntil`: waitUntil only extends execution for
 * 30 seconds after the response, which is far too short for a book. A DO alarm
 * gets 15 minutes of wall time, and the same object gives us per-user state
 * (API key, saved defaults, pending jobs) and natural serialisation of one
 * user's jobs — one binding instead of three.
 */

import { TelegramApi, buildPreview } from "./api.js";
import { signFileUrl, signSourceUrl } from "./proxy.js";
import { runJob, runSplitJob, validateUrl, explainError, UserFacingError } from "./jobs.js";
import { normalizeSourceUrl } from "../shared/source-url.js";
import { containerNameFor } from "./splitter.js";
import type { PartResult } from "./jobs.js";
import { resolveSettings, applyToggle, buildPanel, describeSettings } from "./settings.js";
import {
  PER_JOB_CAP,
  appendLedger,
  audioCost,
  canStart,
  describeAccount,
  describeLedger,
  emptyAccount,
} from "./credits.js";
import type { Account, LedgerEntry } from "./credits.js";
import type { Env, JobSettings, PendingJob, TgMessage, TgUpdate } from "./types.js";
import { MAX_DOWNLOAD_BYTES } from "./api.js";

/** Formats Mistral OCR accepts. DOCX/DOC are deliberately absent — see below. */
const DOC_EXTENSIONS = new Set([".pdf", ".pptx", ".xlsx", ".xls"]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".avif", ".tif", ".tiff"]);
/** Mistral documents WAV, MP3, FLAC, OGG and WEBM — nothing else. */
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".flac", ".ogg", ".oga", ".webm"]);
const DEFERRED_EXTENSIONS = new Set([".docx", ".doc"]);

const MAX_AUDIO_SECONDS = 60 * 60;
const JOB_TTL_MS = 24 * 60 * 60 * 1000;

/** How often one user may ping the owner for access. Protects the owner's inbox. */
const REQUEST_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * Mistral's document ceiling. Worth checking up front: when a file exceeds it,
 * the API reports "File could not be fetched from url", which sends you hunting
 * for a network fault that isn't there.
 */
const MAX_MISTRAL_BYTES = 50 * 1024 * 1024;

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i).toLowerCase();
}

function shortId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 10);
}

export class UserSession {
  private tg: TelegramApi;

  constructor(private ctx: DurableObjectState, private env: Env) {
    this.tg = new TelegramApi(env.TELEGRAM_TOKEN);
  }

  async fetch(request: Request): Promise<Response> {
    // An admin-initiated change, arriving from the owner's own session object.
    // DO stubs are not publicly addressable, so reaching here already implies an
    // in-Worker caller that has passed its own admin check.
    if (new URL(request.url).pathname === "/admin/op") {
      return this.handleAdminOp(await request.json());
    }

    const { update, origin, userId } = (await request.json()) as {
      update: TgUpdate;
      origin: string;
      userId: number;
    };

    try {
      await this.handle(update, origin, userId);
    } catch (e) {
      console.error("session error", e);
    }
    return new Response("ok");
  }

  // ---------------------------------------------------------------- routing

  private async handle(update: TgUpdate, origin: string, userId: number) {
    // Both are needed later by the alarm, which runs without an inbound update.
    await this.ctx.storage.put("origin", origin);
    await this.ctx.storage.put("userId", userId);

    // The only user directory that exists. Durable Objects cannot be enumerated,
    // so this is read back one at a time through the owner's /whois rather than
    // listed — which is why it is recorded on every update rather than at signup.
    const from = update.message?.from ?? update.callback_query?.from;
    if (from) {
      const account = await this.account();
      account.username = from.username;
      account.lastSeen = Date.now();
      await this.putAccount(account);
    }

    if (update.callback_query) return this.onCallback(update.callback_query, userId);
    const msg = update.message;
    if (!msg) return;

    const text = (msg.text ?? "").trim();

    if (text.startsWith("/")) return this.onCommand(msg, text, userId);
    if (msg.document || msg.photo || msg.audio || msg.voice || msg.video) {
      return this.onFile(msg);
    }
    if (text) return this.onText(msg, text);
  }

  private async onCommand(msg: TgMessage, text: string, userId: number) {
    const [cmd, ...rest] = text.split(/\s+/);
    const chatId = msg.chat.id;

    switch (cmd.split("@")[0]) {
      case "/start":
      case "/help":
        return void this.tg.sendMessage(chatId, this.helpText(userId));

      // Keys are the owner's alone. A stranger who finds the bot cannot grant
      // themselves access by pasting one, and no user is ever asked to leave a
      // credential sitting in a chat log.
      case "/setkey": {
        // Scrub the message carrying the key before anything else — including
        // when a non-admin sends it, since it is a live credential either way.
        await this.tg.deleteMessage(chatId, msg.message_id);
        if (!this.isAdmin(userId)) {
          return void this.tg.sendMessage(chatId, "Unknown command. Try /help.");
        }
        const [target, ...keyParts] = rest;
        const key = keyParts.join("").trim();
        if (!/^\d+$/.test(target ?? "") || !key) {
          return void this.tg.sendMessage(chatId, "Usage: /setkey <user_id> <mistral_key>");
        }
        await this.setKeyFor(Number(target), key);
        return void this.tg.sendMessage(
          chatId,
          `Key set for ${target}. I deleted the message containing it.`
        );
      }

      case "/unsetkey": {
        if (!this.isAdmin(userId)) {
          return void this.tg.sendMessage(chatId, "Unknown command. Try /help.");
        }
        const revokeId = rest[0];
        if (!/^\d+$/.test(revokeId ?? "")) {
          return void this.tg.sendMessage(chatId, "Usage: /unsetkey <user_id>");
        }
        await this.setKeyFor(Number(revokeId), null);
        return void this.tg.sendMessage(chatId, `Key removed for ${revokeId}.`);
      }

      // How a stranger reaches the owner. Without it the bot is a dead end for
      // anyone who has not been set up, and the owner never learns they tried.
      case "/request": {
        if (this.isAdmin(userId)) {
          return void this.tg.sendMessage(chatId, "You're the owner — you already have access.");
        }
        if (!this.env.ADMIN_ID) {
          return void this.tg.sendMessage(chatId, "No owner is configured, so I can't pass this on.");
        }
        const last = (await this.ctx.storage.get<number>("lastRequestAt")) ?? 0;
        if (Date.now() - last < REQUEST_COOLDOWN_MS) {
          return void this.tg.sendMessage(
            chatId,
            "You've already asked and I passed it on — give the owner a little time."
          );
        }

        const note = rest.join(" ").trim();
        const who = msg.from?.username
          ? `@${msg.from.username}`
          : msg.from?.first_name ?? "unknown";
        try {
          await this.tg.sendMessage(
            Number(this.env.ADMIN_ID),
            `Access request from ${who} (id ${userId})` +
              (note ? `\n\n"${note}"` : "") +
              `\n\nGrant with:\n/setkey ${userId} <key>`
          );
        } catch (e) {
          // Almost always means the owner has never opened a chat with the bot,
          // so Telegram refuses to let it write to them first.
          console.error("access request delivery failed", e);
          return void this.tg.sendMessage(
            chatId,
            "I couldn't reach the owner just now. Try again later."
          );
        }
        // Recorded only after delivery, so a failed send doesn't cost the user
        // their hour.
        await this.ctx.storage.put("lastRequestAt", Date.now());
        return void this.tg.sendMessage(
          chatId,
          "Sent — the owner will get back to you.\n" +
            "You can include a note next time: /request I need this for work invoices"
        );
      }

      case "/balance":
        return void this.tg.sendMessage(chatId, describeAccount(await this.account()));

      case "/usage": {
        const ledger = (await this.ctx.storage.get<LedgerEntry[]>("ledger")) ?? [];
        return void this.tg.sendMessage(chatId, describeLedger(ledger));
      }

      // Owner-only account management. All of these reach into another user's
      // object, so they are gated here and nowhere else.
      case "/grant":
      case "/setcredit":
      case "/trust":
      case "/untrust":
      case "/whois": {
        if (!this.isAdmin(userId)) {
          return void this.tg.sendMessage(chatId, "Unknown command. Try /help.");
        }
        return void this.adminCommand(chatId, cmd.split("@")[0], rest);
      }

      case "/settings": {
        const defaults = resolveSettings(await this.ctx.storage.get<JobSettings>("defaults"));
        return void this.tg.sendMessage(
          chatId,
          `Your defaults — ${describeSettings(defaults, false)}\n\n` +
            `These apply to every new job. Per-job changes don't touch them ` +
            `unless you press "Save as default".`
        );
      }

      default:
        return void this.tg.sendMessage(chatId, "Unknown command. Try /help.");
    }
  }

  private async onText(msg: TgMessage, text: string) {
    const chatId = msg.chat.id;

    // Waiting for a page range?
    const awaiting = await this.ctx.storage.get<string>("awaitingPages");
    if (awaiting) {
      await this.ctx.storage.delete("awaitingPages");
      const job = await this.ctx.storage.get<PendingJob>(`job:${awaiting}`);
      if (!job) return void this.tg.sendMessage(chatId, "That job expired. Send the file again.");
      // "all" is the documented way to clear a range; storing it literally would make
      // parsePageSpec throw and silently fall back to the whole document anyway.
      job.settings.pages = /^all$/i.test(text) ? undefined : text;
      await this.ctx.storage.put(`job:${awaiting}`, job);
      return void this.renderPanel(job, job.settings.pages ? "Page range set." : "Using all pages.");
    }

    if (/^https?:\/\//i.test(text)) return this.onUrl(msg, text);

    return void this.tg.sendMessage(
      chatId,
      "Send me a PDF, image, audio file, or a direct link to one."
    );
  }

  // ------------------------------------------------------------ job intake

  private async onUrl(msg: TgMessage, url: string) {
    const chatId = msg.chat.id;
    const status = await this.tg.sendMessage(chatId, "Checking link…");

    // Drive, Docs, Dropbox and GitHub links address a viewer page, not the file.
    // Rewrite before validating, so the checks below and the bytes Mistral is
    // eventually handed are all the same URL.
    const source = normalizeSourceUrl(url);
    const target = source.url;

    const check = await validateUrl(target, source.provider);
    if (!check.ok) {
      return void this.tg.editMessageText(
        chatId,
        status.message_id,
        `I can't use that link — ${check.reason}.`
      );
    }

    // A direct-download URL carries no filename in its path, so the header the
    // server sent is the best source. The extension matters: it's what Mistral
    // infers the document type from via the /f/ proxy tail.
    let name = check.fileName ?? source.fileName ?? "document.pdf";
    if (!check.fileName && !source.fileName) {
      try {
        const path = new URL(target).pathname;
        const base = path.split("/").filter(Boolean).pop();
        if (base && base.includes(".")) name = decodeURIComponent(base);
      } catch { /* keep the default */ }
    }

    const ext = extOf(name);
    const kind = IMAGE_EXTENSIONS.has(ext) ? "image" : AUDIO_EXTENSIONS.has(ext) ? "audio" : "url";

    // Over Mistral's ceiling the document has to be cut into parts first, and only
    // a PDF can be cut. Decided here, from the link's content-length, so the panel
    // can offer the merge/separate choice before anything runs.
    let split = false;
    if (check.size != null && check.size > MAX_MISTRAL_BYTES) {
      if (ext !== ".pdf") {
        return void this.tg.editMessageText(
          chatId,
          status.message_id,
          `That file is ${fmtSize(check.size)} — over Mistral's 50 MB limit, and only ` +
            `PDFs can be split into smaller parts.\n\n` +
            `Convert it to PDF, or split it yourself and send the pieces.`
        );
      }
      split = true;
    }

    const job = await this.createJob({
      kind: kind === "url" ? "url" : kind,
      url: target,
      fileName: name,
      fileSize: check.size,
      split,
      chatId,
    });

    await this.tg.deleteMessage(chatId, status.message_id);
    const note = [
      check.size ? fmtSize(check.size) : "Link OK",
      split ? "over 50 MB, will be split" : null,
    ]
      .filter(Boolean)
      .join(" · ");
    await this.renderPanel(job, note);
  }

  private async onFile(msg: TgMessage) {
    const chatId = msg.chat.id;

    // Largest photo size, or whichever attachment type arrived.
    const photo = msg.photo?.[msg.photo.length - 1];
    const src = msg.document ?? msg.audio ?? msg.voice ?? msg.video ?? photo;
    if (!src) return;

    const fileName =
      (msg.document?.file_name ?? msg.audio?.file_name ?? msg.video?.file_name) ??
      (msg.voice ? "voice.ogg" : photo ? "photo.jpg" : "file");
    const ext = extOf(fileName);
    const size = (src as any).file_size as number | undefined;
    const duration = (msg.audio ?? msg.voice ?? msg.video)?.duration;

    // Everything below is decided from metadata Telegram already sent —
    // no download, no API call, so bad input fails instantly and for free.

    if (DEFERRED_EXTENSIONS.has(ext)) {
      return void this.tg.sendMessage(
        chatId,
        "I don't handle Word documents yet. Mistral OCR reads them visually and loses " +
          "hyperlinks and table structure, so the CLI (which parses the Word XML directly) " +
          "gives a much better result. Use `mistral-ocr-cli` for these."
      );
    }

    if (size != null && size > MAX_DOWNLOAD_BYTES) {
      return void this.tg.sendMessage(
        chatId,
        `That file is ${fmtSize(size)}. Telegram only lets bots download files up to 20 MB — ` +
          `this is a hard limit on their side, not a setting I can change.\n\n` +
          `Send me a direct link to it instead — I fetch those myself, and a linked PDF ` +
          `over 50 MB gets split into parts automatically.`
      );
    }

    const isAudio = Boolean(msg.audio || msg.voice) || AUDIO_EXTENSIONS.has(ext);
    const isImage = Boolean(photo) || IMAGE_EXTENSIONS.has(ext);

    if (isAudio) {
      if (ext && !AUDIO_EXTENSIONS.has(ext)) {
        return void this.tg.sendMessage(
          chatId,
          `Mistral transcribes WAV, MP3, FLAC, OGG and WEBM — ${ext} isn't one of them, ` +
            `and I can't convert audio here. Re-encode it and send it again.`
        );
      }
      if (duration != null && duration > MAX_AUDIO_SECONDS) {
        return void this.tg.sendMessage(
          chatId,
          `That's ${Math.round(duration / 60)} minutes. Mistral caps transcription at 60.`
        );
      }
    } else if (!isImage && ext && !DOC_EXTENSIONS.has(ext)) {
      return void this.tg.sendMessage(
        chatId,
        `I can't read ${ext} files. Send a PDF, PPTX, XLSX, an image, or audio.`
      );
    }

    const job = await this.createJob({
      kind: isAudio ? "audio" : isImage ? "image" : "document",
      fileId: src.file_id,
      fileName,
      fileSize: size,
      duration,
      chatId,
    });

    await this.renderPanel(job, size ? fmtSize(size) : undefined);
  }

  private async createJob(
    partial: Omit<PendingJob, "id" | "settings" | "createdAt">
  ): Promise<PendingJob> {
    const defaults = resolveSettings(await this.ctx.storage.get<JobSettings>("defaults"));
    const job: PendingJob = {
      ...partial,
      id: shortId(),
      settings: { ...defaults },
      createdAt: Date.now(),
    };
    await this.ctx.storage.put(`job:${job.id}`, job);
    return job;
  }

  // ---------------------------------------------------------------- panel

  private async renderPanel(job: PendingJob, note?: string) {
    const isAudio = job.kind === "audio";
    const isSplit = Boolean(job.split);
    const header = `${job.fileName}${note ? ` · ${note}` : ""}`;
    const body =
      `${header}\n\n${describeSettings(job.settings, isAudio, isSplit)}\n\n` +
      `Tap to change, then Send.`;
    const markup = buildPanel(job.id, job.settings, isAudio, isSplit);

    if (job.panelMessageId) {
      await this.tg.editMessageText(job.chatId, job.panelMessageId, body, markup);
      return;
    }
    const sent = await this.tg.sendMessage(job.chatId, body, markup);
    job.panelMessageId = sent.message_id;
    await this.ctx.storage.put(`job:${job.id}`, job);
  }

  private async onCallback(cq: NonNullable<TgUpdate["callback_query"]>, userId: number) {
    const data = cq.data ?? "";
    const chatId = cq.message?.chat.id;
    if (!chatId) return void this.tg.answerCallbackQuery(cq.id);

    const parts = data.split(":");
    const action = parts[0];
    const jobId = parts[parts.length - 1];

    const job = await this.ctx.storage.get<PendingJob>(`job:${jobId}`);
    if (!job) {
      await this.tg.answerCallbackQuery(cq.id, "That job expired.");
      return;
    }

    switch (action) {
      case "t": {
        job.settings = applyToggle(job.settings, parts[1]);
        await this.ctx.storage.put(`job:${jobId}`, job);
        await this.tg.answerCallbackQuery(cq.id);
        return void this.renderPanel(job);
      }

      case "pages": {
        await this.ctx.storage.put("awaitingPages", jobId);
        await this.tg.answerCallbackQuery(cq.id);
        return void this.tg.sendMessage(
          chatId,
          "Send the page range — e.g. 3-7, or 1,5,10-15. Send 'all' for the whole document."
        );
      }

      case "save": {
        await this.ctx.storage.put("defaults", job.settings);
        await this.tg.answerCallbackQuery(cq.id, "Saved as your defaults.");
        return void this.renderPanel(job, "saved as default");
      }

      case "cancel": {
        await this.ctx.storage.delete(`job:${jobId}`);
        await this.tg.answerCallbackQuery(cq.id, "Cancelled.");
        return void this.tg.editMessageText(chatId, cq.message!.message_id, "Cancelled.");
      }

      case "run": {
        await this.tg.answerCallbackQuery(cq.id, "Started.");
        const refusal = await this.refuseReason(userId);
        if (refusal) {
          return void this.tg.editMessageText(chatId, cq.message!.message_id, refusal);
        }
        await this.ctx.storage.put(`run:${jobId}`, true);
        await this.tg.editMessageText(chatId, cq.message!.message_id, `${job.fileName}\nQueued…`);
        // Hand off to the alarm so this webhook returns immediately and the
        // job gets the DO's 15-minute wall-clock budget.
        await this.ctx.storage.setAlarm(Date.now() + 50);
        return;
      }
    }
  }

  // ----------------------------------------------------------------- run

  async alarm() {
    const runs = await this.ctx.storage.list<boolean>({ prefix: "run:" });
    for (const runKey of runs.keys()) {
      const jobId = runKey.slice(4);
      await this.ctx.storage.delete(runKey);
      const job = await this.ctx.storage.get<PendingJob>(`job:${jobId}`);
      if (!job) continue;
      await this.execute(job);
      await this.ctx.storage.delete(`job:${jobId}`);
    }
    await this.sweepStaleJobs();
  }

  private async execute(job: PendingJob) {
    const panelId = job.panelMessageId;
    const step = async (msg: string) => {
      if (panelId) await this.tg.editMessageText(job.chatId, panelId, `${job.fileName}\n${msg}`);
    };

    const userId = Number(await this.ctx.storage.get<number>("userId")) || 0;

    // Credits are added here as output reaches the user, never before, and the
    // total is settled in the finally below. A job that dies half way through
    // therefore bills for the parts that arrived and nothing for the rest.
    const charged = { pages: 0 };

    try {
      // Balance may have run out while this sat in the queue.
      const refusal = await this.refuseReason(userId);
      if (refusal) throw new UserFacingError(refusal);

      const apiKey = await this.resolveApiKey(userId);
      if (!apiKey) throw new Error("401 no api key");

      const origin = (await this.ctx.storage.get<string>("origin"))!;

      const summary = job.split
        ? await this.runSplit(job, apiKey, origin, userId, step, charged)
        : await this.runWhole(job, apiKey, origin, step, charged);

      if (panelId) await this.tg.editMessageText(job.chatId, panelId, `${summary} ✅`);
    } catch (e) {
      console.error("job failed", e);
      const explained = explainError(e);
      if (panelId) {
        await this.tg.editMessageText(job.chatId, panelId, `${job.fileName}\n❌ ${explained}`);
      } else {
        await this.tg.sendMessage(job.chatId, `❌ ${explained}`);
      }
    } finally {
      // The owner's own usage is not metered — they are paying Mistral directly.
      if (!this.isAdmin(userId)) await this.charge(charged.pages, job.fileName);
    }
  }

  /** The ordinary path: one document, one OCR call, one file back. */
  private async runWhole(
    job: PendingJob,
    apiKey: string,
    origin: string,
    step: (msg: string) => Promise<void>,
    charged: { pages: number }
  ): Promise<string> {
    let sourceUrl: string;
    if (job.url) {
      // Pasted links are proxied too, not handed to Mistral directly: their
      // fetcher is refused by geo-blocked and reputation-filtered origins that
      // answer Cloudflare without complaint. We stream, so nothing buffers.
      sourceUrl = await signSourceUrl(
        origin,
        this.env.PROXY_SIGNING_KEY,
        job.url,
        job.fileName
      );
    } else {
      await step("Locating file…");
      const file = await this.tg.getFile(job.fileId!);
      if (!file.file_path) throw new Error("Telegram did not return a file path");
      sourceUrl = await signFileUrl(
        origin,
        this.env.PROXY_SIGNING_KEY,
        file.file_path,
        job.fileName
      );
    }

    const result = await runJob(job, apiKey, sourceUrl, step);

    await step("Sending…");
    const summary =
      job.kind === "audio"
        ? `${job.fileName} → transcript`
        : `${job.fileName} → ${result.pagesProcessed}/${result.pageCount} pages`;

    await this.tg.sendDocument(job.chatId, outputName(job), result.content, summary);

    // Billed on the pages Mistral actually returned, which — now that the page
    // range is sent to the API rather than applied to its answer — is exactly
    // what the account was charged for.
    charged.pages =
      job.kind === "audio" ? audioCost(job.duration) : Math.max(1, result.pageCount);

    await this.sendFollowUps(job, result.content, result.warnings);
    return summary;
  }

  /**
   * Over Mistral's 50 MB ceiling: the container cuts the document into parts and
   * each one is OCR'd in turn.
   *
   * Nothing here touches the source bytes — the container holds those, and the
   * parts reach Mistral through the signed `/f/` proxy. In merge mode we do
   * accumulate the extracted *text*, which is a fraction of the PDF's size.
   */
  private async runSplit(
    job: PendingJob,
    apiKey: string,
    origin: string,
    userId: number,
    step: (msg: string) => Promise<void>,
    charged: { pages: number }
  ): Promise<string> {
    const containerName = containerNameFor(userId);
    const separate = job.settings.parts === "separate";
    const base = baseName(job.fileName);
    const collected: PartResult[] = [];
    // The one path where a page count is known before the next call is billed,
    // so it is the one path where the per-job cap can actually be enforced.
    const trusted = (await this.account()).trusted || this.isAdmin(userId);

    const outcome = await runSplitJob(
      job,
      apiKey,
      { env: this.env, containerName, origin },
      step,
      async (part) => {
        if (separate) {
          // Send as we go, so output starts arriving while later parts still run.
          const name = `${base}-part${String(part.part).padStart(2, "0")}.${job.settings.format}`;
          await this.tg.sendDocument(
            job.chatId,
            name,
            part.content,
            `${job.fileName} · part ${part.part} · pages ${part.pageLabel}`
          );
          // Delivered, so bill it now — a later part failing must not un-charge
          // a file the user already has.
          charged.pages += part.pagesProcessed;

          // Only enforceable here. Merge mode delivers nothing until the very
          // end, so cutting it off at the cap would bill the owner for the
          // parts already OCR'd and hand the user an error instead of a file.
          if (!trusted && charged.pages >= PER_JOB_CAP) {
            throw new UserFacingError(
              `Stopped at the ${PER_JOB_CAP}-page limit for a single job. ` +
                `The parts already sent are yours — send the rest as a new job.`
            );
          }
        } else {
          collected.push(part);
        }
      }
    );

    const plural = outcome.partCount === 1 ? "" : "s";
    const summary =
      `${job.fileName} → ${outcome.pagesProcessed}/${outcome.totalPages} pages ` +
      `in ${outcome.partCount} part${plural}`;

    const warnings = [...outcome.warnings];

    if (separate) {
      if (job.settings.preview) {
        warnings.push("Preview skipped — every part arrived as its own file.");
      }
      await this.sendFollowUps(job, null, warnings);
      return summary;
    }

    await step("Merging…");
    const content = collected.map((part) => part.content).join("\n\n");
    await this.tg.sendDocument(job.chatId, outputName(job), content, summary);
    // Merged output is all-or-nothing: nothing was delivered until this landed.
    charged.pages = collected.reduce((n, part) => n + part.pagesProcessed, 0);
    await this.sendFollowUps(job, content, warnings);
    return summary;
  }

  /** Preview excerpt and warnings — the tail both delivery paths share. */
  private async sendFollowUps(
    job: PendingJob,
    content: string | null,
    warnings: string[]
  ): Promise<void> {
    const notes = warnings.length ? `⚠️ ${warnings.join("\n⚠️ ")}` : "";

    if (content && job.settings.preview) {
      const preview = buildPreview(content);
      const tail = preview.truncated ? "\n\n… full text in the file above." : "";
      await this.tg.sendMessage(job.chatId, preview.text + tail + (notes ? `\n\n${notes}` : ""));
    } else if (notes) {
      // Warnings still need to reach the user even with the preview switched off.
      await this.tg.sendMessage(job.chatId, notes);
    }
  }

  // -------------------------------------------------------------- helpers

  /**
   * The owner uses the Worker secret; everyone else must supply their own.
   *
   * Deliberately does NOT mirror `src/worker.ts:84`, whose fallback chain
   * (`user || MISTRAL_API_KEY || DEFAULT_MISTRAL_API_KEY`) would silently bill
   * the owner for every stranger who finds the bot.
   */
  private async resolveApiKey(userId: number): Promise<string | undefined> {
    if (this.isAdmin(userId)) {
      return this.env.MISTRAL_API_KEY;
    }
    // A key the owner pinned to this user, else the shared one. Note this no
    // longer gates access on its own — refuseReason does that.
    return (
      (await this.ctx.storage.get<string>("apiKey")) ?? this.env.DEFAULT_MISTRAL_API_KEY
    );
  }

  private async account(): Promise<Account> {
    return (await this.ctx.storage.get<Account>("account")) ?? emptyAccount();
  }

  private async putAccount(account: Account): Promise<void> {
    await this.ctx.storage.put("account", account);
  }

  /**
   * Why this user may not run a job, or null if they may.
   *
   * This is the access gate. Before credits it was the absence of an API key;
   * now that everyone falls back to a shared one, an empty balance is the only
   * thing standing between a stranger and the owner's Mistral bill.
   */
  private async refuseReason(userId: number): Promise<string | null> {
    if (this.isAdmin(userId)) return null;
    const account = await this.account();
    if (canStart(account)) return null;
    return (
      `You have ${account.balance} credits left, so I can't run this.\n\n` +
      `Send /request to ask the owner for more — your user ID is ${userId}.`
    );
  }

  /** Debit a completed job and record it for /usage. */
  private async charge(cost: number, label: string): Promise<void> {
    if (cost <= 0) return;
    const account = await this.account();
    account.balance -= cost;
    account.lifetime += cost;
    await this.putAccount(account);

    const ledger = (await this.ctx.storage.get<LedgerEntry[]>("ledger")) ?? [];
    await this.ctx.storage.put(
      "ledger",
      appendLedger(ledger, { at: Date.now(), cost, label })
    );
  }

  // ------------------------------------------------------- owner commands

  private async adminCommand(chatId: number, cmd: string, rest: string[]): Promise<void> {
    const target = rest[0];
    const needsAmount = cmd === "/grant" || cmd === "/setcredit";
    if (!/^\d+$/.test(target ?? "")) {
      return void this.tg.sendMessage(
        chatId,
        `Usage: ${cmd} <user_id>${needsAmount ? " <amount>" : ""}`
      );
    }
    const targetId = Number(target);

    if (cmd === "/whois") {
      const res = await this.adminOp(targetId, { op: "whois" });
      return void this.tg.sendMessage(chatId, res.text ?? "No record.");
    }

    if (cmd === "/trust" || cmd === "/untrust") {
      await this.adminOp(targetId, { op: "trust", trusted: cmd === "/trust" });
      return void this.tg.sendMessage(
        chatId,
        `${target} is now ${cmd === "/trust" ? "trusted — runs at zero balance" : "untrusted"}.`
      );
    }

    const amount = Number(rest[1]);
    if (!Number.isFinite(amount)) {
      return void this.tg.sendMessage(chatId, `Usage: ${cmd} <user_id> <amount>`);
    }
    const res = await this.adminOp(targetId, {
      op: cmd === "/grant" ? "grant" : "setcredit",
      amount,
    });
    return void this.tg.sendMessage(chatId, res.text ?? "Done.");
  }

  /** Run an owner-initiated operation against another user's object. */
  private async adminOp(
    targetId: number,
    body: Record<string, unknown>
  ): Promise<{ text?: string }> {
    const ns = this.env.USER_SESSION;
    const stub = ns.get(ns.idFromName(`user:${targetId}`));
    const res = await stub.fetch("https://session/admin/op", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, targetId }),
    });
    return (await res.json()) as { text?: string };
  }

  /**
   * Apply an owner-initiated change to THIS user's account.
   *
   * Reached only through a Durable Object stub, which is not publicly
   * addressable — so arriving here already implies a caller that passed its own
   * admin check in adminCommand.
   */
  private async handleAdminOp(body: any): Promise<Response> {
    const account = await this.account();

    switch (body.op) {
      case "key":
        if (body.key) await this.ctx.storage.put("apiKey", body.key);
        else await this.ctx.storage.delete("apiKey");
        return Response.json({ text: "ok" });

      case "grant":
        account.balance += body.amount;
        await this.putAccount(account);
        return Response.json({
          text: `${body.targetId} now has ${account.balance} credits.`,
        });

      case "setcredit":
        account.balance = body.amount;
        await this.putAccount(account);
        return Response.json({
          text: `${body.targetId} set to ${account.balance} credits.`,
        });

      case "trust":
        account.trusted = Boolean(body.trusted);
        await this.putAccount(account);
        return Response.json({ text: "ok" });

      case "whois": {
        const pinned = await this.ctx.storage.get<string>("apiKey");
        const seen = account.lastSeen
          ? new Date(account.lastSeen).toISOString().slice(0, 16).replace("T", " ")
          : "never";
        return Response.json({
          text: [
            `User ${body.targetId}${account.username ? ` (@${account.username})` : ""}`,
            `Balance: ${account.balance}`,
            `Used so far: ${account.lifetime}`,
            `Trusted: ${account.trusted ? "yes" : "no"}`,
            `Key: ${pinned ? "pinned by you" : "shared default"}`,
            `Last seen: ${seen}`,
          ].join("\n"),
        });
      }
    }

    return Response.json({ text: `unknown op ${body.op}` });
  }

  private isAdmin(userId: number): boolean {
    return Boolean(this.env.ADMIN_ID) && String(userId) === String(this.env.ADMIN_ID);
  }

  /**
   * Write (or clear) another user's stored key.
   *
   * A Durable Object can hold a stub for any other, so the owner's session
   * reaches a user's directly and no public admin route has to exist. The target
   * may never have messaged the bot — its object is created on first write.
   */
  private async setKeyFor(targetId: number, key: string | null): Promise<void> {
    const ns = this.env.USER_SESSION;
    const stub = ns.get(ns.idFromName(`user:${targetId}`));
    await stub.fetch("https://session/admin/op", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "key", key }),
    });
  }

  private async sweepStaleJobs() {
    const jobs = await this.ctx.storage.list<PendingJob>({ prefix: "job:" });
    const cutoff = Date.now() - JOB_TTL_MS;
    for (const [key, job] of jobs) {
      if (job.createdAt < cutoff) await this.ctx.storage.delete(key);
    }
  }

  private helpText(userId: number): string {
    const isAdmin = this.isAdmin(userId);
    return [
      "Send me a document, image, audio file, or a direct link, and I'll return the text.",
      "",
      "Documents: PDF, PPTX, XLSX, XLS (up to 20 MB — Telegram's limit for bots)",
      "Images: JPG, PNG, AVIF, TIFF",
      "Audio: MP3, WAV, FLAC, OGG, WEBM (up to 60 minutes)",
      "Links: anything publicly reachable. PDFs over 50 MB are split into parts",
      "  and processed automatically — you choose one merged file or one per part",
      "Google Drive and Docs share links work directly — paste the link as-is.",
      "  The file has to be shared as \"Anyone with the link\".",
      "",
      "After you send something I'll show the settings — tap to change them, then Send.",
      "",
      isAdmin
        ? "You're the owner, so you use the key configured on the Worker."
        : `Access is granted by the owner. Your user ID is ${userId}.`,
      "",
      "/settings — show your saved defaults",
      ...(isAdmin
        ? [
            "/whois <user_id> — balance, usage, key, last seen",
            "/grant <user_id> <n> — add credits (negative takes them back)",
            "/setcredit <user_id> <n> — set the balance outright",
            "/trust <user_id> — let them run at zero balance",
            "/untrust <user_id> — stop that",
            "/setkey <user_id> <key> — pin them to one of your keys",
            "/unsetkey <user_id> — back to the shared key",
          ]
        : [
            "/balance — credits left",
            "/usage — what your recent jobs cost",
            "/request — ask the owner for more",
          ]),
      "",
      "Word documents aren't supported here — use the CLI, which preserves links and tables.",
    ].join("\n");
  }
}

/** Strip any extension, so output can be named after the input. */
function baseName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "") || "output";
}

function outputName(job: PendingJob): string {
  return `${baseName(job.fileName)}.${job.settings.format}`;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
