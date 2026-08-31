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
import { runJob, runSplitJob, validateUrl, explainError } from "./jobs.js";
import { containerNameFor } from "./splitter.js";
import type { PartResult } from "./jobs.js";
import { resolveSettings, applyToggle, buildPanel, describeSettings } from "./settings.js";
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

      case "/key": {
        // Delete the message carrying the key before doing anything else —
        // otherwise a live credential sits in the chat log permanently.
        await this.tg.deleteMessage(chatId, msg.message_id);
        const key = rest.join("").trim();
        if (!key) {
          return void this.tg.sendMessage(chatId, "Usage: /key YOUR_MISTRAL_KEY");
        }
        await this.ctx.storage.put("apiKey", key);
        return void this.tg.sendMessage(
          chatId,
          "Key saved, and I deleted the message containing it. Use /forgetkey to remove it."
        );
      }

      case "/forgetkey":
        await this.ctx.storage.delete("apiKey");
        return void this.tg.sendMessage(chatId, "Key deleted.");

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

    const check = await validateUrl(url);
    if (!check.ok) {
      return void this.tg.editMessageText(
        chatId,
        status.message_id,
        `I can't use that link — ${check.reason}.`
      );
    }

    let name = "document.pdf";
    try {
      const path = new URL(url).pathname;
      const base = path.split("/").filter(Boolean).pop();
      if (base && base.includes(".")) name = decodeURIComponent(base);
    } catch { /* keep the default */ }

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
      url,
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
        const key = await this.resolveApiKey(userId);
        if (!key) {
          return void this.tg.editMessageText(
            chatId,
            cq.message!.message_id,
            "You need your own Mistral API key first — send /key YOUR_KEY.\n" +
              "Get one at https://console.mistral.ai/api-keys"
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
      const apiKey = await this.resolveApiKey(userId);
      if (!apiKey) throw new Error("401 no api key");

      const origin = (await this.ctx.storage.get<string>("origin"))!;

      const summary = job.split
        ? await this.runSplit(job, apiKey, origin, userId, step)
        : await this.runWhole(job, apiKey, origin, step);

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

  /** The ordinary path: one document, one OCR call, one file back. */
  private async runWhole(
    job: PendingJob,
    apiKey: string,
    origin: string,
    step: (msg: string) => Promise<void>
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
    step: (msg: string) => Promise<void>
  ): Promise<string> {
    const containerName = containerNameFor(userId);
    const separate = job.settings.parts === "separate";
    const base = baseName(job.fileName);
    const collected: PartResult[] = [];

    const outcome = await runSplitJob(
      job,
      apiKey,
      { env: this.env, containerName, origin },
      step,
      async (part) => {
        if (!separate) {
          collected.push(part);
          return;
        }
        // Send as we go, so output starts arriving while later parts still run.
        const name = `${base}-part${String(part.part).padStart(2, "0")}.${job.settings.format}`;
        await this.tg.sendDocument(
          job.chatId,
          name,
          part.content,
          `${job.fileName} · part ${part.part} · pages ${part.pageLabel}`
        );
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
    if (userId && String(userId) === String(this.env.ADMIN_ID)) {
      return this.env.MISTRAL_API_KEY;
    }
    return this.ctx.storage.get<string>("apiKey");
  }

  private async sweepStaleJobs() {
    const jobs = await this.ctx.storage.list<PendingJob>({ prefix: "job:" });
    const cutoff = Date.now() - JOB_TTL_MS;
    for (const [key, job] of jobs) {
      if (job.createdAt < cutoff) await this.ctx.storage.delete(key);
    }
  }

  private helpText(userId: number): string {
    const isAdmin = String(userId) === String(this.env.ADMIN_ID);
    return [
      "Send me a document, image, audio file, or a direct link, and I'll return the text.",
      "",
      "Documents: PDF, PPTX, XLSX, XLS (up to 20 MB — Telegram's limit for bots)",
      "Images: JPG, PNG, AVIF, TIFF",
      "Audio: MP3, WAV, FLAC, OGG, WEBM (up to 60 minutes)",
      "Links: anything publicly reachable. PDFs over 50 MB are split into parts",
      "  and processed automatically — you choose one merged file or one per part",
      "",
      "After you send something I'll show the settings — tap to change them, then Send.",
      "",
      isAdmin
        ? "You're the owner, so you use the key configured on the Worker."
        : "First set your Mistral key with /key YOUR_KEY (I delete the message straight after).",
      "",
      "/settings — show your saved defaults",
      "/forgetkey — delete your stored key",
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
