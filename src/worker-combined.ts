/**
 * Combined Cloudflare Worker entry point.
 *
 * Serves both the MCP server (src/worker.ts) and the Telegram bot
 * (src/telegram/) from a single Worker deployment, so both surfaces share one
 * domain, one set of secrets and one Workers Builds pipeline. Both call the
 * docling-api Worker (https://github.com/EngDawood/docling) over HTTP.
 *
 * Routing:
 *   /tg/webhook, /setup                     → Telegram bot
 *   everything else (/mcp, /sse, ...)       → MCP OCR server
 *
 * Durable Object classes must be exported from the Worker's `main` entry point
 * for wrangler's bindings to resolve them, so they are re-exported here rather
 * than from src/telegram/index.ts alone.
 */

import mcpWorker from "./worker.js";
import telegramWorker from "./telegram/index.js";

export { UserSession } from "./telegram/session.js";

function isTelegramPath(path: string): boolean {
  return path === "/tg/webhook" || path === "/setup";
}

export default {
  fetch(request: Request, env: any, ctx: ExecutionContext): Response | Promise<Response> {
    const path = new URL(request.url).pathname;

    if (path === "/") {
      return new Response("docling worker: mcp + telegram bot ok", {
        headers: { "content-type": "text/plain" },
      });
    }

    return isTelegramPath(path)
      ? telegramWorker.fetch(request, env, ctx)
      : mcpWorker.fetch(request, env, ctx);
  },
};
