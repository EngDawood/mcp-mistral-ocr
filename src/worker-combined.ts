/**
 * Combined Cloudflare Worker entry point.
 *
 * Serves both the MCP OCR server (src/worker.ts) and the Telegram bot
 * (src/telegram/) from a single Worker deployment (`mistral-ocr-telegram`),
 * so both surfaces share one domain, one set of secrets and one Workers
 * Builds pipeline instead of two.
 *
 * Routing:
 *   /tg/webhook, /setup, /f/<token>/<name>  → Telegram bot
 *   everything else (/mcp, /sse, ...)       → MCP OCR server
 *
 * Durable Object / Container classes must be exported from the Worker's
 * `main` entry point for wrangler's bindings to resolve them, so they are
 * re-exported here rather than from src/telegram/index.ts alone.
 */

import mcpWorker from "./worker.js";
import telegramWorker from "./telegram/index.js";

export { UserSession } from "./telegram/session.js";
export { PdfSplitter } from "./telegram/splitter.js";

function isTelegramPath(path: string): boolean {
  return path === "/tg/webhook" || path === "/setup" || path.startsWith("/f/");
}

export default {
  fetch(request: Request, env: any, ctx: ExecutionContext): Response | Promise<Response> {
    const path = new URL(request.url).pathname;

    if (path === "/") {
      return new Response("mistral-ocr worker: mcp + telegram bot ok", {
        headers: { "content-type": "text/plain" },
      });
    }

    return isTelegramPath(path)
      ? telegramWorker.fetch(request, env, ctx)
      : mcpWorker.fetch(request, env, ctx);
  },
};
