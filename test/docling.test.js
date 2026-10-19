import { test } from "node:test";
import assert from "node:assert/strict";
import { convertUrl, convertBytes, transcribe, DoclingError } from "../dist/shared/docling.js";
import { extractTables, extractHyperlinks, finalize, parseLangs } from "../dist/shared/convert.js";

const client = { baseUrl: "https://docling.example", apiKey: "k" };
const BREAK = "<!--docling-page-break-->";

/** Replace global fetch with a script of canned responses; returns the calls made. */
function mockFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? "GET", headers: init.headers, body: init.body };
    calls.push(call);
    return handler(call);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A service that accepts a job, reports it started once, then succeeds. */
function happyService(md) {
  let polls = 0;
  return (call) => {
    if (call.url.endsWith("/v1/convert/source/async")) return json({ task_id: "t1", task_status: "pending" });
    if (call.url.includes("/v1/status/poll/")) {
      polls++;
      return json({ task_id: "t1", task_status: polls < 2 ? "started" : "success" });
    }
    if (call.url.endsWith("/v1/result/t1")) {
      return json({ document: { md_content: md }, status: "success", processing_time: 1.5 });
    }
    throw new Error(`unexpected ${call.url}`);
  };
}

test("convertUrl submits http_sources with the API key and splits pages", async () => {
  const m = mockFetch(happyService(["one", "two", "three"].join(BREAK)));
  try {
    const result = await convertUrl(client, "https://x.test/a.pdf", { ocrLang: ["ar", "en"] });
    assert.deepEqual(result.pages, ["one", "two", "three"]);
    assert.deepEqual(result.pageNumbers, [1, 2, 3]);

    const submit = m.calls[0];
    assert.equal(submit.headers["X-Api-Key"], "k");
    const body = JSON.parse(submit.body);
    assert.deepEqual(body.http_sources, [{ url: "https://x.test/a.pdf" }]);
    assert.deepEqual(body.options.ocr_lang, ["ar", "en"]);
    assert.equal(body.options.md_page_break_placeholder, BREAK);
    assert.equal(body.options.page_range, undefined);
  } finally { m.restore(); }
});

test("a sparse page selection asks for the covering range and filters locally", async () => {
  // Pages 3..6 come back; the caller wanted 3 and 6 only, plus 9 which is past the end.
  const m = mockFetch(happyService(["p3", "p4", "p5", "p6"].join(BREAK)));
  try {
    const result = await convertUrl(client, "https://x.test/a.pdf", { pages: new Set([3, 6, 9]) });
    const body = JSON.parse(m.calls[0].body);
    assert.deepEqual(body.options.page_range, [3, 9]);
    assert.deepEqual(result.pages, ["p3", "p6"]);
    assert.deepEqual(result.pageNumbers, [3, 6]);
    assert.match(result.warnings.join(" "), /9/);
  } finally { m.restore(); }
});

test("convertBytes sends the file as base64 with its filename", async () => {
  const m = mockFetch(happyService("hello"));
  try {
    await convertBytes(client, new Uint8Array([104, 105]), "scan.pdf");
    const body = JSON.parse(m.calls[0].body);
    assert.deepEqual(body.file_sources, [{ base64_string: "aGk=", filename: "scan.pdf" }]);
  } finally { m.restore(); }
});

test("image markers are dropped by default and kept on request", async () => {
  const md = "before\n\n<!-- image -->\n\nafter";
  let m = mockFetch(happyService(md));
  try {
    const dropped = await convertUrl(client, "https://x.test/a.pdf", {});
    assert.equal(dropped.markdown.includes("<!-- image -->"), false);
  } finally { m.restore(); }
  m = mockFetch(happyService(md));
  try {
    const kept = await convertUrl(client, "https://x.test/a.pdf", { images: "keep" });
    assert.equal(kept.markdown.includes("<!-- image -->"), true);
  } finally { m.restore(); }
});

test("the budget refusal surfaces the server's own message and is not retried", async () => {
  const m = mockFetch(() => json({ error: "monthly container budget reached" }, 429));
  try {
    await assert.rejects(
      () => convertUrl(client, "https://x.test/a.pdf", {}),
      (e) => e instanceof DoclingError && e.status === 429 && /budget/.test(e.message)
    );
    assert.equal(m.calls.length, 1);
  } finally { m.restore(); }
});

test("a failed task reports the reason from its result", async () => {
  const m = mockFetch((call) => {
    if (call.url.endsWith("/async")) return json({ task_id: "t1", task_status: "failure" });
    return json({ status: "failure", errors: [{ error_message: "unsupported format" }] });
  });
  try {
    await assert.rejects(() => convertUrl(client, "https://x.test/a.xyz", {}), /unsupported format/);
  } finally { m.restore(); }
});

test("transcribe posts raw bytes with the content type, or JSON for a URL", async () => {
  const m = mockFetch(() => json({ text: "مرحبا", vtt: "", segments: [], language: "ar", duration: 3 }));
  try {
    const a = await transcribe(client, { bytes: new Uint8Array([1, 2]), contentType: "audio/mpeg" }, { language: "ar" });
    assert.equal(a.text, "مرحبا");
    assert.equal(m.calls[0].url, "https://docling.example/v1/transcribe?language=ar");
    assert.equal(m.calls[0].headers["content-type"], "audio/mpeg");

    await transcribe(client, { url: "https://x.test/a.mp3" });
    assert.equal(m.calls[1].headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(m.calls[1].body), { url: "https://x.test/a.mp3" });
  } finally { m.restore(); }
});

test("extractTables finds pipe tables with a separator row and reports pages", () => {
  const page1 = "intro\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\ntext";
  const page2 = "| not | a table |\n\nplain";
  const page3 = "|x|y|\n|:-:|--:|\n|1|2|\n|3|4|";
  const tables = extractTables([page1, page2, page3], [1, 2, 3]);
  assert.equal(tables.length, 2);
  assert.deepEqual(tables.map((t) => t.page), [1, 3]);
  assert.equal(tables[0].content.split("\n").length, 3);
});

test("extractHyperlinks skips images", () => {
  const links = extractHyperlinks("see [docs](https://a.test) and ![pic](img.png)");
  assert.deepEqual(links, [{ text: "docs", url: "https://a.test" }]);
});

test("finalize only cleans markdown output", () => {
  const repeated = Array(4).fill("HEADER").join("\n") + "\nbody";
  assert.equal(finalize(repeated, "markdown", true).cleaned, true);
  assert.equal(finalize(repeated, "text", true).cleaned, false);
});

test("parseLangs defaults to Arabic and English", () => {
  assert.deepEqual(parseLangs(undefined), ["ar", "en"]);
  assert.deepEqual(parseLangs(" fr , de "), ["fr", "de"]);
});
