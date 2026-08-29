/**
 * Signed file proxy.
 *
 * Mistral must fetch the bytes itself (streaming, so the 128 MB isolate never
 * buffers a document), but Telegram's own download URL embeds the bot token —
 * handing that to a third party grants full control of the bot and puts the
 * token in their request logs.
 *
 * So the Worker exposes a short-lived signed URL instead:
 *
 *     /f/<base64url(payload)>.<hmac>/<filename>
 *
 * The filename tail is cosmetic but load-bearing: Mistral infers the document
 * type from the extension.
 */

const encoder = new TextEncoder();

interface ProxyPayload {
  /** Telegram file_path from getFile. Mutually exclusive with `u`. */
  p?: string;
  /** Absolute source URL, for links the user pasted. Mutually exclusive with `p`. */
  u?: string;
  /** Expiry, epoch seconds. */
  e: number;
}

/** What a verified token points at. */
export type ProxyTarget =
  | { kind: "telegram"; filePath: string }
  | { kind: "url"; url: string };

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function sign(secret: string, data: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return b64urlEncode(new Uint8Array(sig));
}

/**
 * Mint a signed URL for a Telegram file path.
 * TTL defaults to 30 minutes — comfortably longer than an OCR run, and well
 * inside Telegram's own ~1 hour link lifetime.
 */
export async function signFileUrl(
  origin: string,
  secret: string,
  filePath: string,
  fileName: string,
  ttlSeconds = 1800
): Promise<string> {
  return mint(origin, secret, { p: filePath }, fileName, ttlSeconds);
}

/**
 * Mint a signed URL that proxies an arbitrary source link.
 *
 * Needed because Mistral's fetcher cannot reach every host — geo-blocked and
 * reputation-filtered origins refuse it while answering Cloudflare fine. Routing
 * through the Worker means Mistral only ever fetches us, and we stream the bytes
 * so nothing is buffered against the 128 MB isolate limit.
 */
export async function signSourceUrl(
  origin: string,
  secret: string,
  sourceUrl: string,
  fileName: string,
  ttlSeconds = 1800
): Promise<string> {
  return mint(origin, secret, { u: sourceUrl }, fileName, ttlSeconds);
}

async function mint(
  origin: string,
  secret: string,
  target: Omit<ProxyPayload, "e">,
  fileName: string,
  ttlSeconds: number
): Promise<string> {
  const payload: ProxyPayload = { ...target, e: Math.floor(Date.now() / 1000) + ttlSeconds };
  const encoded = b64urlEncode(encoder.encode(JSON.stringify(payload)));
  const sig = await sign(secret, encoded);
  return `${origin}/f/${encoded}.${sig}/${encodeURIComponent(safeName(fileName))}`;
}

export async function verifyFileToken(
  secret: string,
  token: string
): Promise<{ ok: true; target: ProxyTarget } | { ok: false; reason: string }> {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return { ok: false, reason: "malformed token" };

  const encoded = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = await sign(secret, encoded);
  if (!timingSafeEqual(sig, expected)) return { ok: false, reason: "bad signature" };

  let payload: ProxyPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(encoded)));
  } catch {
    return { ok: false, reason: "malformed payload" };
  }

  if (payload.e < Math.floor(Date.now() / 1000)) return { ok: false, reason: "expired" };

  if (payload.p) return { ok: true, target: { kind: "telegram", filePath: payload.p } };
  if (payload.u) return { ok: true, target: { kind: "url", url: payload.u } };
  return { ok: false, reason: "empty payload" };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Strip anything that would break the URL tail while keeping the extension. */
function safeName(name: string): string {
  const cleaned = name.replace(/[^\w.\-]+/g, "_").replace(/_+/g, "_");
  return cleaned.length ? cleaned.slice(-80) : "document";
}
