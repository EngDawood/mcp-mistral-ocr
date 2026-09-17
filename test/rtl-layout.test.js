/**
 * Tests for right-to-left column ordering.
 *
 * Runs against the compiled output, so `npm run build` first (the `test`
 * script does it for you). Pure geometry and string work — no network, no
 * API key.
 *
 * The page geometry below mirrors the real OCR response for a two-column
 * Arabic journal article (761 x 1015 at 92 dpi).
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  rtlRatio,
  isRtlText,
  documentIsRtl,
  pageIsRtl,
  reorderRtlBlocks,
  applyRtlColumnOrder,
} from "../dist/shared/rtl-layout.js";

const WIDTH = 761;

const ARABIC_INTRO = "الحمد لله رب العالمين والصلاة والسلام على خير الأنبياء وسيد المرسلين";
const ARABIC_BODY = "ومن بين المهن التي أصبحت تمنح لمنسوبيها شهادات ورخص لمزاولتها مهنة التعليم";
const ENGLISH_ABSTRACT = "The study aimed to find out the obstacles to obtaining a professional license.";

/** A block in the left column. */
const left = (y, content, type = "text") => ({
  topLeftX: 87, topLeftY: y, bottomRightX: 376, bottomRightY: y + 100, content, type,
});

/** A block in the right column. */
const right = (y, content, type = "text") => ({
  topLeftX: 385, topLeftY: y, bottomRightX: 671, bottomRightY: y + 100, content, type,
});

/** A block spanning both columns. */
const full = (y, content, type = "title") => ({
  topLeftX: 102, topLeftY: y, bottomRightX: 657, bottomRightY: y + 40, content, type,
});

test("rtl ratio ignores digits and punctuation", () => {
  assert.equal(rtlRatio("(٣.٦٦) ،"), 0);
  assert.equal(rtlRatio("مرحبا"), 1);
  assert.equal(rtlRatio("hello"), 0);
  assert.ok(isRtlText("مرحبا بكم hello"));
  assert.ok(!isRtlText("hello there مرحبا"));
});

test("direction is decided across the whole document, not one page", () => {
  // A cover page that is half English still belongs to an Arabic document.
  const pages = [
    { markdown: `${ENGLISH_ABSTRACT} ${ARABIC_INTRO}` },
    { markdown: ARABIC_BODY },
  ];
  assert.ok(documentIsRtl(pages));
  assert.ok(!documentIsRtl([{ markdown: ENGLISH_ABSTRACT }]));
});

test("a clearly English page inside an Arabic document stays left-to-right", () => {
  assert.ok(!pageIsRtl(ENGLISH_ABSTRACT, true));
  assert.ok(pageIsRtl(ARABIC_BODY, false));
  // A mixed page follows the document.
  const mixed = `${ENGLISH_ABSTRACT} ${ARABIC_INTRO}`;
  assert.ok(pageIsRtl(mixed, true));
  assert.ok(!pageIsRtl(mixed, false));
});

test("right column is read before the left", () => {
  const blocks = [
    left(307, "LEFT-TOP"),
    right(332, "RIGHT-TOP"),
    left(640, "LEFT-BOTTOM"),
    right(615, "RIGHT-BOTTOM"),
  ];
  const order = reorderRtlBlocks(blocks, WIDTH).map((b) => b.content);
  assert.deepEqual(order, ["RIGHT-TOP", "RIGHT-BOTTOM", "LEFT-TOP", "LEFT-BOTTOM"]);
});

test("header stays first, footer last, and a full-width block divides the bands", () => {
  const blocks = [
    { ...full(56, "HEADER", "header") },
    full(88, "TITLE"),
    left(195, "LEFT-AUTHOR"),
    right(195, "RIGHT-AUTHOR"),
    { ...full(946, "FOOTER", "footer") },
  ];
  const order = reorderRtlBlocks(blocks, WIDTH).map((b) => b.content);
  assert.deepEqual(order, ["HEADER", "TITLE", "RIGHT-AUTHOR", "LEFT-AUTHOR", "FOOTER"]);
});

test("a full-width block keeps blocks above it from mixing with those below", () => {
  const blocks = [
    left(100, "L1"),
    right(100, "R1"),
    full(300, "DIVIDER"),
    left(400, "L2"),
    right(400, "R2"),
  ];
  const order = reorderRtlBlocks(blocks, WIDTH).map((b) => b.content);
  assert.deepEqual(order, ["R1", "L1", "DIVIDER", "R2", "L2"]);
});

test("a repeated paragraph-length block is dropped", () => {
  // Mistral sometimes emits the tail of a merged column a second time.
  const longParagraph = ARABIC_INTRO.repeat(3);
  const blocks = [
    { topLeftX: 86, topLeftY: 85, bottomRightX: 672, bottomRightY: 799, content: longParagraph, type: "text" },
    right(829, longParagraph.slice(-140)),
  ];
  const order = reorderRtlBlocks(blocks, WIDTH).map((b) => b.content);
  assert.deepEqual(order, [longParagraph]);
});

test("a short heading that repeats body text is kept", () => {
  // The Arabic title is quoted verbatim in the abstract's first sentence;
  // filtering it as a duplicate would delete the page's title.
  const title = "معوقات الحصول على الرخصة المهنية";
  const abstract = `هدفت الدراسة إلى معرفة ${title} بالمملكة العربية السعودية. ${ARABIC_INTRO.repeat(2)}`;
  const blocks = [full(88, title), right(332, abstract)];
  const order = reorderRtlBlocks(blocks, WIDTH).map((b) => b.content);
  assert.deepEqual(order, [title, abstract]);
});

test("applyRtlColumnOrder reorders an Arabic page and leaves an English one alone", () => {
  const dimensions = { width: WIDTH, height: 1015 };
  const arabicPage = {
    markdown: `${ARABIC_BODY}\n\n${ARABIC_INTRO}`,
    dimensions,
    blocks: [left(307, ARABIC_BODY), right(332, ARABIC_INTRO)],
  };
  const englishPage = {
    markdown: `${ENGLISH_ABSTRACT}\n\nSecond column of English text here.`,
    dimensions,
    blocks: [left(307, ENGLISH_ABSTRACT), right(332, "Second column of English text here.")],
  };

  const result = applyRtlColumnOrder([arabicPage, englishPage]);
  assert.ok(result.applied);
  assert.equal(result.markdown[0], `${ARABIC_INTRO}\n\n${ARABIC_BODY}`);
  assert.equal(result.markdown[1], englishPage.markdown, "English page must be untouched");
});

test("mode off and mode on override detection", () => {
  const dimensions = { width: WIDTH, height: 1015 };
  const page = {
    markdown: `${ARABIC_BODY}\n\n${ARABIC_INTRO}`,
    dimensions,
    blocks: [left(307, ARABIC_BODY), right(332, ARABIC_INTRO)],
  };

  const off = applyRtlColumnOrder([page], "off");
  assert.ok(!off.applied);
  assert.equal(off.markdown[0], page.markdown);

  const englishPage = {
    markdown: `${ENGLISH_ABSTRACT}\n\nSecond column.`,
    dimensions,
    blocks: [left(307, ENGLISH_ABSTRACT), right(332, "Second column.")],
  };
  const forced = applyRtlColumnOrder([englishPage], "on");
  assert.ok(forced.applied);
  assert.equal(forced.markdown[0], `Second column.\n\n${ENGLISH_ABSTRACT}`);
});

test("pages without blocks pass through unchanged and warn", () => {
  const result = applyRtlColumnOrder([{ markdown: ARABIC_BODY }]);
  assert.ok(!result.applied);
  assert.equal(result.markdown[0], ARABIC_BODY);
  assert.equal(result.warnings.length, 1);
});
