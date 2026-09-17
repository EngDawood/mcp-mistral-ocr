/**
 * Direct client for POST /v1/ocr.
 *
 * Why not the SDK: @mistralai/mistralai 1.13 validates the request body
 * against a zod schema written before `include_blocks` existed, and unknown
 * fields are silently dropped before the request is sent — so asking the SDK
 * for paragraph bounding boxes gets you a response with no `blocks` and no
 * error. Those boxes are what ./rtl-layout.ts needs to repair the column order
 * of right-to-left documents, so the text-extraction calls go out through
 * `fetch` instead.
 *
 * The response is converted back to the SDK's camelCase shape, so callers that
 * already read `page.markdown` or `image.imageBase64` need no changes. Calls
 * that pass an annotation format still go through the SDK: the schema in those
 * requests carries user-defined field names that must not be renamed.
 *
 * `fetch` is global in Node 18+ and in Workers, so this file stays portable.
 */

const OCR_ENDPOINT = "https://api.mistral.ai/v1/ocr";

/**
 * Request fields this client understands, camelCase → the API's snake_case.
 * An unknown field throws rather than being dropped — the silent-drop
 * behaviour above is exactly the bug this module exists to avoid.
 */
const REQUEST_FIELDS: Record<string, string> = {
  model: "model",
  id: "id",
  document: "document",
  pages: "pages",
  includeImageBase64: "include_image_base64",
  imageLimit: "image_limit",
  imageMinSize: "image_min_size",
  tableFormat: "table_format",
  extractHeader: "extract_header",
  extractFooter: "extract_footer",
  includeBlocks: "include_blocks",
  confidenceScoresGranularity: "confidence_scores_granularity",
};

/** Fields of the `document` object, camelCase → snake_case. */
const DOCUMENT_FIELDS: Record<string, string> = {
  type: "type",
  documentUrl: "document_url",
  documentName: "document_name",
  imageUrl: "image_url",
  fileId: "file_id",
};

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** Recursively rename response keys from snake_case to camelCase. */
function camelizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelizeKeys);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[snakeToCamel(key)] = camelizeKeys(val);
  }
  return out;
}

function buildBody(params: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    const apiKeyName = REQUEST_FIELDS[key];
    if (!apiKeyName) {
      throw new Error(
        `ocrProcess() does not support the '${key}' OCR parameter — add it to REQUEST_FIELDS ` +
          `in src/shared/ocr-api.ts, or call the SDK directly for this request.`
      );
    }
    if (key === "document" && value !== null && typeof value === "object") {
      const doc: Record<string, unknown> = {};
      for (const [docKey, docValue] of Object.entries(value as Record<string, unknown>)) {
        const apiDocKey = DOCUMENT_FIELDS[docKey];
        if (!apiDocKey) {
          throw new Error(`ocrProcess() does not support the document field '${docKey}'.`);
        }
        doc[apiDocKey] = docValue;
      }
      body[apiKeyName] = doc;
      continue;
    }
    body[apiKeyName] = value;
  }
  return body;
}

/**
 * Run OCR with paragraph bounding boxes available.
 *
 * Takes the same camelCase parameters as `client.ocr.process()` and returns the
 * same shape, plus `pages[].blocks` when `includeBlocks` is set. Throws an
 * Error whose message includes the API's response body, so callers can keep
 * matching on it to retry without unsupported fields.
 */
export async function ocrProcess(
  apiKey: string,
  params: Record<string, unknown>
): Promise<any> {
  const response = await fetch(OCR_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(buildBody(params)),
  });

  const raw = await response.text();

  if (!response.ok) {
    const error: any = new Error(
      `Mistral OCR request failed (${response.status} ${response.statusText}): ${raw.slice(0, 1000)}`
    );
    error.statusCode = response.status;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Mistral OCR returned a non-JSON response: ${raw.slice(0, 200)}`);
  }

  return camelizeKeys(parsed);
}
