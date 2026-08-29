/**
 * Minimal Telegram Bot API client.
 *
 * Every method returns the raw `result` field, or throws with the description
 * Telegram sent back. The bot token never leaves this module.
 */

import type { TgFile, TgMessage } from "./types.js";

const API_ROOT = "https://api.telegram.org";

/** Bot API caps a text message at 4096 characters. */
export const MAX_MESSAGE_CHARS = 4096;

/** Bots cannot download files larger than this via getFile. */
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

export class TelegramApi {
  constructor(private token: string) {}

  private async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${API_ROOT}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    const body = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!body.ok) {
      throw new Error(`Telegram ${method} failed: ${body.description ?? res.status}`);
    }
    return body.result as T;
  }

  sendMessage(chatId: number, text: string, replyMarkup?: unknown): Promise<TgMessage> {
    // Deliberately no parse_mode: OCR output is full of unescaped _ * [ #,
    // and MarkdownV2 rejects the whole message on an unbalanced entity.
    return this.call<TgMessage>("sendMessage", {
      chat_id: chatId,
      text: truncateForMessage(text),
      reply_markup: replyMarkup,
      disable_web_page_preview: true,
    });
  }

  editMessageText(chatId: number, messageId: number, text: string, replyMarkup?: unknown) {
    return this.call<TgMessage | boolean>("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: truncateForMessage(text),
      reply_markup: replyMarkup,
    }).catch((e) => {
      // "message is not modified" is routine when a progress step repeats.
      if (String(e).includes("not modified")) return false;
      throw e;
    });
  }

  /** Mandatory after every callback query, or the user is left with a spinner. */
  answerCallbackQuery(id: string, text?: string) {
    return this.call<boolean>("answerCallbackQuery", {
      callback_query_id: id,
      text,
    }).catch(() => false);
  }

  deleteMessage(chatId: number, messageId: number) {
    return this.call<boolean>("deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    }).catch(() => false);
  }

  getFile(fileId: string): Promise<TgFile> {
    return this.call<TgFile>("getFile", { file_id: fileId });
  }

  /** Build the direct download URL. Contains the bot token — never hand this out. */
  fileUrl(filePath: string): string {
    return `${API_ROOT}/file/bot${this.token}/${filePath}`;
  }

  async sendDocument(chatId: number, fileName: string, content: string, caption?: string) {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    if (caption) form.set("caption", caption.slice(0, 1024));
    form.set("document", new Blob([content], { type: "text/plain" }), fileName);

    const res = await fetch(`${API_ROOT}/bot${this.token}/sendDocument`, {
      method: "POST",
      body: form,
    });
    const body = (await res.json()) as { ok: boolean; description?: string };
    if (!body.ok) throw new Error(`Telegram sendDocument failed: ${body.description ?? res.status}`);
  }

  setWebhook(url: string, secret: string) {
    return this.call<boolean>("setWebhook", {
      url,
      secret_token: secret,
      allowed_updates: ["message", "callback_query"],
    });
  }

  // --- public bot info, set once via /setup -------------------------------

  setMyName(name: string) {
    return this.call<boolean>("setMyName", { name });
  }

  /** Shown on the bot's profile page, before the user starts a chat. */
  setMyDescription(description: string) {
    return this.call<boolean>("setMyDescription", { description });
  }

  /** Shown in the chat list and link previews. Max 120 chars. */
  setMyShortDescription(shortDescription: string) {
    return this.call<boolean>("setMyShortDescription", {
      short_description: shortDescription.slice(0, 120),
    });
  }

  setMyCommands(commands: Array<{ command: string; description: string }>) {
    return this.call<boolean>("setMyCommands", { commands });
  }
}

function truncateForMessage(text: string): string {
  if (text.length <= MAX_MESSAGE_CHARS) return text;
  return text.slice(0, MAX_MESSAGE_CHARS - 1) + "…";
}

/**
 * Cut a preview to fit in one message, ending on a line boundary so the
 * excerpt stays readable rather than stopping mid-word.
 */
export function buildPreview(content: string, limit = 3500): { text: string; truncated: boolean } {
  if (content.length <= limit) return { text: content, truncated: false };
  const slice = content.slice(0, limit);
  const lastBreak = slice.lastIndexOf("\n");
  return {
    text: lastBreak > limit * 0.5 ? slice.slice(0, lastBreak) : slice,
    truncated: true,
  };
}
