/**
 * UserSession — one Durable Object per Telegram user.
 *
 * Why a DO rather than `ctx.waitUntil`: waitUntil only extends execution for
 * 30 seconds after the response, which is far too short for a book. A DO alarm
 * gets 15 minutes of wall time, and the same object gives us per-user state
 * (access flag, saved defaults, pending jobs) and natural serialisation of one
 * user's jobs — one binding instead of three.
 */

import { TelegramApi, buildPreview } from "./api.js";
import { runJob, validateUrl, explainError } from "./jobs.js";
import { normalizeSourceUrl } from "../shared/source-url.js";
import { parseLangs } from "../shared/convert.js";
import { resolveSettings, applyToggle, buildPanel, describeSettings } from "./settings.js";
import type { Env, JobSettings, PendingJob, TgMessage, TgUpdate } from "./types.js";
import { MAX_DOWNLOAD_BYTES } from "./api.js";

/** Formats Docling converts. */
const DOC_EXTENSIONS = new Set([".pdf", ".docx", ".doc", ".pptx", ".xlsx", ".xls"]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"]);
/**
 * What Whisper on Workers AI transcribes: WAV, MP3, FLAC, OGG, M4A and WEBM; the
 * rest are the same codecs under another name (MPEG/MPGA are MP3, OGA and OPUS
 * are Ogg, MP4 is the M4A container), so a video's soundtrack works too.
 * Anything else would need transcoding, which a Worker can't do.
 */
const AUDIO_EXTENSIONS = new Set([
  ".mp3", ".mpeg", ".mpga", ".wav", ".flac", ".ogg", ".oga", ".opus", ".m4a", ".mp4", ".webm",
]);
/** Name for audio Telegram sent without one — the format is inferred from it. */
const AUDIO_MIME_EXTENSIONS: Record<string, string> = {
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/flac": ".flac",
  "audio/x-flac": ".flac",
  "audio/ogg": ".ogg",
  "audio/opus": ".ogg",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/webm": ".webm",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
};

/** The docling-api Worker's own cap on one audio upload. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const JOB_TTL_MS = 24 * 60 * 60 * 1000;

/** How often one user may ping the owner for access. Protects the owner's inbox. */
const REQUEST_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * Largest linked document accepted. The container fetches links itself, so this
 * is about its 6 GiB of memory and the monthly time budget, not the isolate.
 */
const MAX_LINK_BYTES = 200 * 1024 * 1024;

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
    // An admin-initiated write, arriving from the owner's own session object.
    // DO stubs are not publicly addressable, so reaching here already implies an
    // in-Worker caller that has passed its own admin check.
    if (new URL(request.url).pathname === "/admin/access") {
      const { allowed } = (await request.json()) as { allowed: boolean };
      if (allowed) await this.ctx.storage.put("allowed", true);
      else await this.ctx.storage.delete("allowed");
      return new Response("ok");
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

    if (update.callback_query) return this.onCallback(update.callback_query, userId);
    const msg = update.message;
    if (!msg) return;

    const text = (msg.text ?? "").trim();

    if (text.startsWith("/")) return this.onCommand(msg, text, userId);
    if (msg.document || msg.photo || msg.audio || msg.voice || msg.video || msg.video_note) {
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

      // Access is the owner's to give. Every conversion spends the owner's
      // container hours, so a stranger who finds the bot cannot grant themselves
      // any by asking.
      case "/allow": {
        if (!this.isAdmin(userId)) {
          return void this.tg.sendMessage(chatId, "Unknown command. Try /help.");
        }
        const target = rest[0];
        if (!/^\d+$/.test(target ?? "")) {
          return void this.tg.sendMessage(chatId, "Usage: /allow <user_id>");
        }
        await this.setAccessFor(Number(target), true);
        return void this.tg.sendMessage(chatId, `${target} can use the bot now.`);
      }

      case "/deny": {
        if (!this.isAdmin(userId)) {
          return void this.tg.sendMessage(chatId, "Unknown command. Try /help.");
        }
        const revokeId = rest[0];
        if (!/^\d+$/.test(revokeId ?? "")) {
          return void this.tg.sendMessage(chatId, "Usage: /deny <user_id>");
        }
        await this.setAccessFor(Number(revokeId), false);
        return void this.tg.sendMessage(chatId, `Access removed for ${revokeId}.`);
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
              `\n\nGrant with:\n/allow ${userId}`
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
      "Send me a document, image, audio file, or a direct link to one."
    );
  }

  // ------------------------------------------------------------ job intake

  private async onUrl(msg: TgMessage, url: string) {
    const chatId = msg.chat.id;
    const status = await this.tg.sendMessage(chatId, "Checking link…");

    // Drive, Docs, Dropbox and GitHub links address a viewer page, not the file.
    // Rewrite before validating, so the checks below and the URL Docling is
    // eventually handed are all the same.
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
    // server sent is the best source. The extension matters: it's what Docling
    // infers the document type from.
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

    if (kind === "audio") {
      if (check.size != null && check.size > MAX_AUDIO_BYTES) {
        return void this.tg.editMessageText(
          chatId,
          status.message_id,
          `That audio is ${fmtSize(check.size)}. I can transcribe up to ${fmtSize(MAX_AUDIO_BYTES)} per file.`
        );
      }
    } else if (check.size != null && check.size > MAX_LINK_BYTES) {
      return void this.tg.editMessageText(
        chatId,
        status.message_id,
        `That file is ${fmtSize(check.size)}, over my ${fmtSize(MAX_LINK_BYTES)} limit for links. ` +
          `Use the CLI for it.`
      );
    }

    const job = await this.createJob({
      kind: kind === "url" ? "url" : kind,
      url: target,
      fileName: name,
      fileSize: check.size,
      chatId,
    });

    await this.tg.deleteMessage(chatId, status.message_id);
    await this.renderPanel(job, check.size ? fmtSize(check.size) : "Link OK");
  }

  private async onFile(msg: TgMessage) {
    const chatId = msg.chat.id;

    // Largest photo size, or whichever attachment type arrived.
    const photo = msg.photo?.[msg.photo.length - 1];
    const media = msg.audio ?? msg.voice ?? msg.video ?? msg.video_note;
    const src = msg.document ?? media ?? photo;
    if (!src) return;

    const mime = (src as { mime_type?: string }).mime_type?.toLowerCase();
    const fileName =
      (msg.document?.file_name ?? msg.audio?.file_name ?? msg.video?.file_name) ??
      (msg.voice
        ? "voice.ogg"
        : msg.video_note
          ? "video_note.mp4"
          : photo
            ? "photo.jpg"
            : `${media ? "audio" : "file"}${(mime && AUDIO_MIME_EXTENSIONS[mime]) ?? ""}`);
    const ext = extOf(fileName);
    const size = (src as any).file_size as number | undefined;
    const duration = media?.duration;

    // Everything below is decided from metadata Telegram already sent —
    // no download, no API call, so bad input fails instantly and for free.

    if (size != null && size > MAX_DOWNLOAD_BYTES) {
      return void this.tg.sendMessage(
        chatId,
        `That file is ${fmtSize(size)}. Telegram only lets bots download files up to 20 MB — ` +
          `this is a hard limit on their side, not a setting I can change.\n\n` +
          `Send me a direct link to it instead — the converter fetches those itself.`
      );
    }

    // A video is only ever useful here for its soundtrack.
    const isAudio = Boolean(media) || AUDIO_EXTENSIONS.has(ext);
    const isImage = Boolean(photo) || IMAGE_EXTENSIONS.has(ext);

    if (isAudio) {
      if (ext && !AUDIO_EXTENSIONS.has(ext)) {
        return void this.tg.sendMessage(
          chatId,
          `I transcribe MP3, WAV, FLAC, OGG, OPUS, M4A, MP4 and WEBM — ${ext} isn't ` +
            `one of them, and I can't convert audio here. Re-encode it and send it again.`
        );
      }
      if (size != null && size > MAX_AUDIO_BYTES) {
        return void this.tg.sendMessage(
          chatId,
          `That audio is ${fmtSize(size)}. I can transcribe up to ${fmtSize(MAX_AUDIO_BYTES)} per file.`
        );
      }
    } else if (!isImage && ext && !DOC_EXTENSIONS.has(ext)) {
      return void this.tg.sendMessage(
        chatId,
        `I can't read ${ext} files. Send a PDF, Word, PowerPoint or Excel file, an image, or audio.`
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
    const header = `${job.fileName}${note ? ` · ${note}` : ""}`;
    const body =
      `${header}\n\n${describeSettings(job.settings, isAudio)}\n\n` +
      `Tap to change, then Send.`;
    const markup = buildPanel(job.id, job.settings, isAudio);

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
        if (!(await this.hasAccess(userId))) {
          return void this.tg.editMessageText(
            chatId,
            cq.message!.message_id,
            "You don't have access yet — send /request to ask the owner.\n" +
              `Your user ID is ${userId}.`
          );
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

    try {
      const userId = Number(await this.ctx.storage.get<number>("userId")) || 0;
      if (!(await this.hasAccess(userId))) throw new Error("no access");

      const summary = await this.runWhole(job, step);
      if (panelId) await this.tg.editMessageText(job.chatId, panelId, `${summary} ✅`);
    } catch (e) {
      console.error("job failed", e);
      const explained = explainError(e);
      if (panelId) {
        await this.tg.editMessageText(job.chatId, panelId, `${job.fileName}\n❌ ${explained}`);
      } else {
        await this.tg.sendMessage(job.chatId, `❌ ${explained}`);
      }
    }
  }

  /** One document, one conversion, one file back. */
  private async runWhole(job: PendingJob, step: (msg: string) => Promise<void>): Promise<string> {
    // Pasted links go to Docling as URLs: the container downloads them, so the
    // Worker never buffers a large file. Telegram files are at most 20 MB, so
    // those are fetched here and sent along as bytes.
    let bytes: Uint8Array | undefined;
    if (!job.url) {
      await step("Fetching file…");
      const file = await this.tg.getFile(job.fileId!);
      if (!file.file_path) throw new Error("Telegram did not return a file path");
      bytes = await this.tg.downloadFile(file.file_path);
    }

    const result = await runJob(
      job,
      {
        client: { baseUrl: this.env.DOCLING_URL, apiKey: this.env.DOCLING_API_KEY },
        ocrLang: parseLangs(this.env.OCR_LANG),
        bytes,
        url: job.url,
      },
      step
    );

    await step("Sending…");
    const summary =
      job.kind === "audio"
        ? `${job.fileName} → transcript`
        : `${job.fileName} → ${result.pagesProcessed} pages`;

    await this.tg.sendDocument(job.chatId, outputName(job), result.content, summary);
    await this.sendFollowUps(job, result.content, result.warnings);
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
   * The owner always has access; everyone else needs the owner's /allow.
   *
   * Every conversion spends the owner's container hours, so there is no
   * fallback that lets a stranger through.
   */
  private async hasAccess(userId: number): Promise<boolean> {
    if (this.isAdmin(userId)) return true;
    return Boolean(await this.ctx.storage.get<boolean>("allowed"));
  }

  private isAdmin(userId: number): boolean {
    return Boolean(this.env.ADMIN_ID) && String(userId) === String(this.env.ADMIN_ID);
  }

  /**
   * Grant or revoke another user's access.
   *
   * A Durable Object can hold a stub for any other, so the owner's session
   * reaches a user's directly and no public admin route has to exist. The target
   * may never have messaged the bot — its object is created on first write.
   */
  private async setAccessFor(targetId: number, allowed: boolean): Promise<void> {
    const ns = this.env.USER_SESSION;
    const stub = ns.get(ns.idFromName(`user:${targetId}`));
    await stub.fetch("https://session/admin/access", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allowed }),
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
      "Documents: PDF, DOCX, DOC, PPTX, XLSX, XLS (up to 20 MB — Telegram's limit for bots)",
      "Images: JPG, PNG, BMP, WEBP, TIFF",
      "Audio: MP3, WAV, FLAC, OGG, OPUS, M4A, WEBM, voice notes, and the sound of",
      "  MP4 videos (up to 25 MB)",
      "Links: anything publicly reachable, up to 200 MB. Google Drive and Docs share",
      "  links work directly; the file has to be shared as \"Anyone with the link\".",
      "",
      "After you send something I'll show the settings — tap to change them, then Send.",
      "The first job after a quiet spell is slower while the converter wakes up.",
      "",
      isAdmin
        ? "You're the owner, so you always have access."
        : `Access is granted by the owner. Your user ID is ${userId}.`,
      "",
      "/settings — show your saved defaults",
      ...(isAdmin
        ? [
            "/allow <user_id> — give a user access",
            "/deny <user_id> — revoke it",
          ]
        : ["/request — ask the owner for access"]),
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
