/**
 * Tests for share-link normalisation.
 *
 * Runs against the compiled output, so `npm run build` first (the `test`
 * script does it for you). Pure string work — no network, no API key.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSourceUrl,
  extractDriveId,
  filenameFromContentDisposition,
} from "../dist/shared/source-url.js";

const DRIVE_ID = "1x5yCv59czz0IGkRHl5pNdeXv1G8LriO9";
const DRIVE_DIRECT = `https://drive.usercontent.google.com/download?id=${DRIVE_ID}&export=download&confirm=t`;

test("drive share links become direct downloads", () => {
  const shapes = [
    `https://drive.google.com/file/d/${DRIVE_ID}/view?usp=sharing`,
    `https://drive.google.com/file/d/${DRIVE_ID}/view`,
    `https://drive.google.com/file/d/${DRIVE_ID}/preview`,
    `https://drive.google.com/open?id=${DRIVE_ID}`,
    `https://drive.google.com/uc?id=${DRIVE_ID}&export=download`,
  ];
  for (const url of shapes) {
    const out = normalizeSourceUrl(url);
    assert.equal(out.url, DRIVE_DIRECT, `failed for ${url}`);
    assert.equal(out.provider, "google-drive");
  }
});

test("confirm=t is always present, so large files skip the scan interstitial", () => {
  const { url } = normalizeSourceUrl(`https://drive.google.com/file/d/${DRIVE_ID}/view`);
  assert.match(url, /[?&]confirm=t(&|$)/);
});

test("google docs, sheets and slides export as pdf", () => {
  const cases = [
    [`https://docs.google.com/document/d/${DRIVE_ID}/edit`,
     `https://docs.google.com/document/d/${DRIVE_ID}/export?format=pdf`],
    [`https://docs.google.com/spreadsheets/d/${DRIVE_ID}/edit#gid=0`,
     `https://docs.google.com/spreadsheets/d/${DRIVE_ID}/export?format=pdf`],
    // Slides takes a path segment where the other two take a query parameter.
    [`https://docs.google.com/presentation/d/${DRIVE_ID}/edit`,
     `https://docs.google.com/presentation/d/${DRIVE_ID}/export/pdf`],
  ];
  for (const [input, expected] of cases) {
    const out = normalizeSourceUrl(input);
    assert.equal(out.url, expected);
    assert.equal(out.provider, "google-docs");
  }
});

test("a docs link is never mistaken for a drive file", () => {
  // Both carry an id in the same position; only the product path separates them,
  // and a native Doc has no binary to fetch by file id.
  const out = normalizeSourceUrl(`https://docs.google.com/document/d/${DRIVE_ID}/edit`);
  assert.doesNotMatch(out.url, /drive\.usercontent/);
});

test("dropbox preview links force the download", () => {
  const out = normalizeSourceUrl("https://www.dropbox.com/s/abc123/report.pdf?dl=0");
  assert.match(out.url, /[?&]dl=1(&|$)/);
  assert.equal(out.fileName, "report.pdf");
  assert.equal(out.provider, "dropbox");
});

test("github blob links become raw", () => {
  const out = normalizeSourceUrl("https://github.com/octocat/hello/blob/main/docs/spec.pdf");
  assert.equal(out.url, "https://raw.githubusercontent.com/octocat/hello/main/docs/spec.pdf");
  assert.equal(out.fileName, "spec.pdf");
});

test("ordinary urls pass through untouched", () => {
  for (const url of [
    "https://example.com/paper.pdf",
    "https://arxiv.org/pdf/2401.00001v1",
    "http://example.com/a/b/c",
  ]) {
    const out = normalizeSourceUrl(url);
    assert.equal(out.url, url);
    assert.equal(out.provider, undefined);
  }
});

test("surrounding whitespace is trimmed", () => {
  const out = normalizeSourceUrl(`  https://drive.google.com/file/d/${DRIVE_ID}/view  `);
  assert.equal(out.url, DRIVE_DIRECT);
});

test("extractDriveId handles path and query forms, and rejects junk", () => {
  assert.equal(extractDriveId(`https://drive.google.com/file/d/${DRIVE_ID}/view`), DRIVE_ID);
  assert.equal(extractDriveId(`https://drive.google.com/open?id=${DRIVE_ID}`), DRIVE_ID);
  assert.equal(extractDriveId("https://drive.google.com/drive/my-drive"), null);
  assert.equal(extractDriveId("not a url at all"), null);
});

test("content-disposition filenames are read, including RFC 5987", () => {
  assert.equal(
    filenameFromContentDisposition('attachment; filename="Khaled_Network_Project_Report.pdf"'),
    "Khaled_Network_Project_Report.pdf"
  );
  assert.equal(
    filenameFromContentDisposition("attachment; filename=plain.pdf"),
    "plain.pdf"
  );
  assert.equal(
    filenameFromContentDisposition("attachment; filename*=UTF-8''report%20final.pdf"),
    "report final.pdf"
  );
  assert.equal(filenameFromContentDisposition(null), undefined);
  assert.equal(filenameFromContentDisposition("attachment"), undefined);
});
