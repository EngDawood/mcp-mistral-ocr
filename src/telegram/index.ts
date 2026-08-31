/**
 * Telegram bot Worker entry point.
 *
 * Routes:
 *   POST /tg/webhook        Telegram updates (authenticated by secret header)
 *   GET  /f/<token>/<name>  Signed file proxy — streams a Telegram file to Mistral
 *   POST /setup             Register the webhook and the bot's public info
 *   GET  /                  Liveness
 *
 * The Worker itself is deliberately thin: it authenticates, works out which
 * user an update belongs to, and hands the whole thing to that user's Durable
 * Object. All state and all long-running work live there.
 */

import { TelegramApi } from "./api.js";
import { verifyFileToken } from "./proxy.js";
import { fetchPart } from "./splitter.js";
import type { Env, TgUpdate } from "./types.js";

export { UserSession } from "./session.js";
export { PdfSplitter } from "./splitter.js";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/" ) {
      return new Response("mistral-ocr telegram bot: ok", {
        headers: { "content-type": "text/plain" },
      });
    }

    if (path === "/tg/webhook") return handleWebhook(request, env, url.origin);
    if (path.startsWith("/f/")) return handleProxy(path, env);
    if (path === "/setup") return handleSetup(request, env, url);

    return new Response("not found", { status: 404 });
  },
};

async function handleWebhook(request: Request, env: Env, origin: string): Promise<Response> {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

  // Anyone can guess the URL; only Telegram knows the secret.
  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (!secret || secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  let update: TgUpdate;
  try {
    update = (await request.json()) as TgUpdate;
  } catch {
    return new Response("bad request", { status: 400 });
  }

  const from = update.message?.from ?? update.callback_query?.from;
  const userId = from?.id;
  // Ignore anything we can't attribute to a user — including channel posts.
  if (!userId || from?.is_bot) return new Response("ok");

  const id = env.USER_SESSION.idFromName(`user:${userId}`);
  const stub = env.USER_SESSION.get(id);

  // Always answer Telegram 200 quickly; if the session throws, we swallow it
  // rather than let Telegram retry and duplicate the job.
  try {
    await stub.fetch("https://session/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ update, origin, userId }),
    });
  } catch (e) {
    console.error("dispatch failed", e);
  }
  return new Response("ok");
}

/**
 * Stream a Telegram file to whoever holds a valid signed token.
 *
 * This exists so Mistral can fetch the bytes itself without ever seeing the
 * raw Telegram URL, which embeds the bot token.
 */
async function handleProxy(path: string, env: Env): Promise<Response> {
  // /f/<token>/<filename>
  const rest = path.slice(3);
  const slash = rest.indexOf("/");
  const token = slash < 0 ? rest : rest.slice(0, slash);

  const verified = await verifyFileToken(env.PROXY_SIGNING_KEY, token);
  if (!verified.ok) return new Response(verified.reason, { status: 403 });

  // One part of a split document. Its bytes only exist on the splitter
  // container's disk, so this hop goes inward rather than out to the internet.
  if (verified.target.kind === "part") {
    const { container, jobId, index } = verified.target;
    const part = await fetchPart(env, container, jobId, index);
    if (!part.ok || !part.body) {
      return new Response("part fetch failed", { status: 502 });
    }
    return new Response(part.body, {
      headers: {
        "content-type": "application/pdf",
        "content-length": part.headers.get("content-length") ?? "",
        "cache-control": "no-store",
      },
    });
  }

  let upstreamUrl: string;
  const headers: Record<string, string> = {};
  if (verified.target.kind === "telegram") {
    const tg = new TelegramApi(env.TELEGRAM_TOKEN);
    upstreamUrl = tg.fileUrl(verified.target.filePath);
  } else {
    upstreamUrl = verified.target.url;
    // Some origins refuse unfamiliar clients outright. We are fetching a link the
    // user explicitly handed us, so present as an ordinary browser.
    headers["user-agent"] =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
    headers["accept"] = "*/*";
  }

  const upstream = await fetch(upstreamUrl, { headers, redirect: "follow" });
  if (!upstream.ok || !upstream.body) {
    return new Response("upstream fetch failed", { status: 502 });
  }

  // Stream straight through — never buffered, so document size is irrelevant
  // to the 128 MB isolate limit.
  return new Response(upstream.body, {
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
      "content-length": upstream.headers.get("content-length") ?? "",
      "cache-control": "no-store",
    },
  });
}

/**
 * One-shot registration: point Telegram at this Worker and publish the bot's
 * name, description and command list.
 */
async function handleSetup(request: Request, env: Env, url: URL): Promise<Response> {
  const provided = url.searchParams.get("secret") ?? request.headers.get("x-setup-secret");
  if (!provided || provided !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  const tg = new TelegramApi(env.TELEGRAM_TOKEN);
  const results: Record<string, unknown> = {};

  try {
    results.webhook = await tg.setWebhook(`${url.origin}/tg/webhook`, env.TELEGRAM_WEBHOOK_SECRET);
    results.name = await tg.setMyName("Mistral OCR");
    results.shortDescription = await tg.setMyShortDescription(
      "Send a PDF, image or audio file — get the text back."
    );
    results.description = await tg.setMyDescription(
      "I extract text from documents using Mistral OCR.\n\n" +
        "Send a PDF, PPTX, XLSX or image (up to 20 MB), an audio file to transcribe " +
        "(up to 60 minutes), or a direct link to any of those. Linked PDFs over " +
        "50 MB are split into parts and processed automatically. " +
        "You'll get a settings panel to pick the output format, page range and image " +
        "handling before anything runs.\n\n" +
        "Set your own Mistral API key with /key to get started."
    );
    results.commands = await tg.setMyCommands([
      { command: "help", description: "What I can do and how" },
      { command: "settings", description: "Show your saved defaults" },
      { command: "key", description: "Store your Mistral API key" },
      { command: "forgetkey", description: "Delete your stored key" },
    ]);
  } catch (e: any) {
    return Response.json({ ok: false, error: String(e?.message ?? e), results }, { status: 500 });
  }

  return Response.json({ ok: true, webhookUrl: `${url.origin}/tg/webhook`, results });
}
