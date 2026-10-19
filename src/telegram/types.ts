/// <reference types="@cloudflare/workers-types" />

/**
 * Shared types for the Telegram bot surface.
 *
 * Only the subset of the Bot API we actually consume is modelled here — hand-rolled
 * rather than pulled from a dependency, to keep the Worker bundle small.
 */

export interface Env {
  // Secrets
  TELEGRAM_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  /** Key for the docling-api Worker. Spent on behalf of ADMIN_ID and allowed users. */
  DOCLING_API_KEY: string;

  // Config
  /** Base URL of the docling-api Worker. */
  DOCLING_URL: string;
  ADMIN_ID?: string;
  /** Comma separated OCR languages. Defaults to "ar,en". */
  OCR_LANG?: string;

  // Bindings
  USER_SESSION: DurableObjectNamespace;
}

// --- job model -------------------------------------------------------------

export type OutputFormat = "md" | "txt";

/** Image handling in markdown output. */
export type ImageMode = "drop" | "keep" | "embed";

export interface JobSettings {
  format: OutputFormat;
  images: ImageMode;
  clean: boolean;
  /** OCR every page even when it has a text layer. */
  forceOcr: boolean;
  /** Send an inline excerpt alongside the file. Off by default — the file is the deliverable. */
  preview: boolean;
  /** Page spec like "1,5,10-15". Undefined means the whole document. */
  pages?: string;
}

/** What a job operates on, once the incoming message has been resolved. */
export type JobKind = "document" | "image" | "audio" | "url";

export interface PendingJob {
  id: string;
  kind: JobKind;
  /** Telegram file_id — absent for url jobs. */
  fileId?: string;
  /** Direct URL — only for url jobs. */
  url?: string;
  fileName: string;
  fileSize?: number;
  /** Audio/video duration in seconds, when Telegram told us. */
  duration?: number;
  chatId: number;
  /** The confirm panel message, so it can be edited in place. */
  panelMessageId?: number;
  settings: JobSettings;
  createdAt: number;
}

// --- Telegram Bot API ------------------------------------------------------

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: string;
}

export interface TgDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TgPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TgAudio {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_name?: string;
  file_size?: number;
}

export interface TgVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TgVideo {
  file_id: string;
  file_unique_id: string;
  duration: number;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TgVideoNote {
  file_id: string;
  file_unique_id: string;
  duration: number;
  file_size?: number;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  caption?: string;
  document?: TgDocument;
  photo?: TgPhotoSize[];
  audio?: TgAudio;
  voice?: TgVoice;
  video?: TgVideo;
  video_note?: TgVideoNote;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface TgFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}
