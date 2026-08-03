import { Mistral } from "@mistralai/mistralai";
import { promises as fs } from "fs";
import * as path from "path";
import mammoth from "mammoth";
import TurndownService from "turndown";
import { CliArgs, IMAGE_MIME } from "./args.js";
import { resolveApiKey, markdownToText, cleanMarkdown } from "./utils.js";

/**
 * Calls client.ocr.process() with the given document URL and options.
 * Retries once without header/footer flags if the API version doesn't support them.
 *
 * includeImageBase64 is requested only when we actually need the pixels:
 *   - OCR the image inline (default)
 * It is skipped for --imgs (refs kept as-is) and --drop-imgs (refs removed).
 */
async function runOcr(
  client: Mistral,
  documentUrl: string,
  model: string,
  extractHeader: boolean,
  extractFooter: boolean,
  includeImageBase64: boolean
): Promise<Awaited<ReturnType<typeof client.ocr.process>>> {
  const params: Record<string, unknown> = {
    document: { type: "document_url", documentUrl },
    model,
    includeImageBase64,
  };
  if (!extractHeader) params["extractHeader"] = false;
  if (!extractFooter) params["extractFooter"] = false;

  try {
    return await client.ocr.process(params as Parameters<typeof client.ocr.process>[0]);
  } catch (err) {
    const msg = String(err);
    if (msg.includes("extractHeader") || msg.includes("extractFooter")) {
      delete params["extractHeader"];
      delete params["extractFooter"];
      if (!extractHeader || !extractFooter) {
        process.stderr.write("  Note: Header/footer extraction control not supported by this API version\n");
      }
      return await client.ocr.process(params as Parameters<typeof client.ocr.process>[0]);
    }
    throw err;
  }
}

/**
 * Remove every markdown image ref and collapse the blank lines left behind.
 * Used by --drop-imgs for both the OCR path and the mammoth DOCX path
 * (mammoth inlines images as base64 data URIs).
 */
function stripImageRefs(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * Build a map of imageId → base64 data URI from OCR response pages.
 */
function buildImageMap(pages: Array<any>): Map<string, string> {
  const map = new Map<string, string>();
  for (const page of pages) {
    if (!page.images) continue;
    for (const img of page.images) {
      if (img.id && img.imageBase64) {
        // imageBase64 may already include the data URI prefix or just raw base64
        const dataUri = img.imageBase64.startsWith("data:")
          ? img.imageBase64
          : `data:image/jpeg;base64,${img.imageBase64}`;
        map.set(img.id, dataUri);
      }
    }
  }
  return map;
}

/**
 * OCR every embedded image in the markdown and replace the placeholder with its text.
 * Placeholders look like: ![img-0.jpeg](img-0.jpeg)
 *
 * If dropImgs is true, strips the placeholders without any OCR call.
 * If keepImgs is true, leaves them as-is (standard markdown image refs).
 */
async function resolveImages(
  markdown: string,
  imageMap: Map<string, string>,
  client: Mistral,
  model: string,
  keepImgs: boolean,
  embedImgs: boolean,
  dropImgs: boolean
): Promise<string> {
  if (keepImgs && !dropImgs) {
    // Just leave the markdown image refs intact — nothing to do
    return markdown;
  }

  // Find all image placeholders: ![anything](id)
  const imgPattern = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const matches = [...markdown.matchAll(imgPattern)];
  if (matches.length === 0) return markdown;

  let result = markdown;

  // Remove every image ref outright — no base64, no OCR calls
  if (dropImgs) return stripImageRefs(result);

  for (const match of matches) {
    const [fullMatch, , imgId] = match;
    const baseId = imgId.replace(/\.[^.]+$/, "");
    const dataUri = imageMap.get(imgId) ?? imageMap.get(baseId);

    if (!dataUri) {
      // No base64 available — remove the placeholder silently
      result = result.replace(fullMatch, "");
      continue;
    }

    try {
      process.stderr.write(`  OCR-ing embedded image: ${imgId}\n`);
      const ocrResponse = await client.ocr.process({
        document: { type: "image_url", imageUrl: dataUri },
        model,
      } as any);

      const imgText = (ocrResponse.pages as any[])
        ?.map((p: any) => p.markdown)
        .join("\n\n")
        .trim();

      if (embedImgs) {
        // Embed image as base64 data URI + add OCR description caption below
        const caption = imgText ? `\n\n> **Image description:** ${imgText}` : "";
        result = result.replace(fullMatch, `![${baseId}](${dataUri})${caption}`);
      } else {
        // Replace the image placeholder with the extracted text (or nothing if empty)
        result = result.replace(fullMatch, imgText ? `\n${imgText}\n` : "");
      }
    } catch (err) {
      process.stderr.write(`  Warning: Could not OCR image ${imgId}: ${(err as Error).message}\n`);
      if (embedImgs) {
        // Still embed the image even if OCR description failed
        result = result.replace(fullMatch, `![${baseId}](${dataUri})`);
      } else {
        result = result.replace(fullMatch, "");
      }
    }
  }

  return result;
}

function buildContent(
  pages: Array<{ markdown: string }>,
  pageNumbers: Set<number> | null,
  toTxt: boolean,
  clean: boolean
): { content: string; processedCount: number; warnings: string[] } {
  const warnings: string[] = [];
  let selectedPages: string[];

  if (pageNumbers) {
    selectedPages = [];
    pages.forEach((page, idx) => {
      if (pageNumbers.has(idx + 1)) selectedPages.push(page.markdown);
    });
    const invalid = [...pageNumbers].filter((n) => n > pages.length);
    if (invalid.length > 0) {
      warnings.push(
        `Requested pages ${invalid.sort((a, b) => a - b).join(", ")} are out of range (PDF has ${pages.length} pages)`
      );
    }
  } else {
    selectedPages = pages.map((p) => p.markdown);
  }

  let markdown = selectedPages.join("\n\n");
  if (clean && !toTxt) {
    process.stderr.write("  Cleaning markdown content...\n");
    markdown = cleanMarkdown(markdown);
  }

  const content = toTxt ? markdownToText(markdown) : markdown;
  return { content, processedCount: selectedPages.length, warnings };
}

export async function processDocx(
  docxPath: string,
  args: CliArgs,
  outputPath: string,
  onStep?: (msg: string) => void
): Promise<{ outputPath: string; pageCount: number }> {
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });

  // Preserve tables
  td.addRule("table", {
    filter: ["table"],
    replacement(_content, node) {
      const rows = Array.from((node as HTMLElement).querySelectorAll("tr"));
      if (rows.length === 0) return _content;
      const toRow = (tr: Element) =>
        "| " + Array.from(tr.querySelectorAll("td, th")).map((c) => (c.textContent ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").trim()).join(" | ") + " |";
      const header = toRow(rows[0]);
      const sep = "| " + Array.from(rows[0].querySelectorAll("td, th")).map(() => "---").join(" | ") + " |";
      const body = rows.slice(1).map(toRow).join("\n");
      return `\n\n${header}\n${sep}\n${body}\n\n`;
    },
  });

  onStep?.("Parsing Word document...");
  const result = await mammoth.convertToHtml({ path: docxPath });
  onStep?.("Converting to Markdown...");
  let markdown = td.turndown(result.value);

  // mammoth inlines images as base64 data URIs — strip them when images aren't wanted
  if (args.dropImgs) markdown = stripImageRefs(markdown);

  if (args.clean && !args.toTxt) {
    process.stderr.write("  Cleaning markdown content...\n");
    markdown = cleanMarkdown(markdown);
  }

  const content = args.toTxt ? markdownToText(markdown) : markdown;
  onStep?.("Writing output...");
  await fs.writeFile(outputPath, content, "utf-8");
  return { outputPath, pageCount: 1 };
}

export async function processImage(
  imagePath: string,
  args: CliArgs,
  outputPath: string,
  onStep?: (msg: string) => void
): Promise<void> {
  const client = new Mistral({ apiKey: resolveApiKey(args.apiKey) });
  const ext = path.extname(imagePath).toLowerCase();
  const mime = IMAGE_MIME[ext] ?? "image/jpeg";
  onStep?.("Reading image...");
  const fileBytes = await fs.readFile(imagePath);
  const base64 = fileBytes.toString("base64");
  const dataUri = `data:${mime};base64,${base64}`;

  onStep?.("Running OCR...");
  const response = await client.ocr.process({
    document: { type: "image_url", imageUrl: dataUri },
    model: args.model,
  } as any);

  const pages = response.pages as Array<{ markdown: string }>;
  const markdown = pages.map((p) => p.markdown).join("\n\n");
  const content = args.toTxt ? markdownToText(markdown) : markdown;
  onStep?.("Writing output...");
  await fs.writeFile(outputPath, content, "utf-8");
}

export async function processUrl(
  url: string,
  args: CliArgs,
  pageNumbers: Set<number> | null,
  outputPath: string,
  onStep?: (msg: string) => void
): Promise<{ outputPath: string; pageCount: number }> {
  const client = new Mistral({ apiKey: resolveApiKey(args.apiKey) });
  const needsImageBase64 = !args.toTxt && !args.keepImgs && !args.dropImgs;
  onStep?.("Running OCR...");
  const response = await runOcr(client, url, args.model, args.extractHeader, args.extractFooter, needsImageBase64);

  let pages = response.pages as Array<any>;
  if (!args.toTxt) {
    const imageMap = buildImageMap(pages);
    if (imageMap.size > 0 || args.dropImgs) {
      onStep?.(args.dropImgs ? "Removing images..." : `Resolving ${imageMap.size} embedded image(s)...`);
      const resolvedPages = await Promise.all(
        pages.map(async (page) => ({
          ...page,
          markdown: await resolveImages(page.markdown, imageMap, client, args.model, args.keepImgs, args.embedImgs, args.dropImgs),
        }))
      );
      pages = resolvedPages;
    }
  }

  const { content, processedCount, warnings } = buildContent(pages, pageNumbers, args.toTxt, args.clean);
  for (const w of warnings) process.stderr.write(`  Warning: ${w}\n`);
  onStep?.("Writing output...");
  await fs.writeFile(outputPath, content, "utf-8");
  return { outputPath, pageCount: processedCount };
}

export async function processPdf(
  pdfPath: string,
  args: CliArgs,
  pageNumbers: Set<number> | null,
  outputPath: string,
  onStep?: (msg: string) => void
): Promise<{ outputPath: string; pageCount: number }> {
  const client = new Mistral({ apiKey: resolveApiKey(args.apiKey) });
  onStep?.("Uploading to Mistral API...");
  const fileBytes = await fs.readFile(pdfPath);
  const uploaded = await client.files.upload({
    file: { fileName: path.basename(pdfPath), content: new Blob([fileBytes]) },
    purpose: "ocr" as Parameters<typeof client.files.upload>[0]["purpose"],
  });
  const signed = await client.files.getSignedUrl({ fileId: uploaded.id, expiry: 1 });
  const needsImageBase64 = !args.toTxt && !args.keepImgs && !args.dropImgs;
  onStep?.("Running OCR...");
  const response = await runOcr(client, signed.url, args.model, args.extractHeader, args.extractFooter, needsImageBase64);

  let pages = response.pages as Array<any>;
  if (!args.toTxt) {
    const imageMap = buildImageMap(pages);
    if (imageMap.size > 0 || args.dropImgs) {
      onStep?.(args.dropImgs ? "Removing images..." : `Resolving ${imageMap.size} embedded image(s)...`);
      const resolvedPages = await Promise.all(
        pages.map(async (page) => ({
          ...page,
          markdown: await resolveImages(page.markdown, imageMap, client, args.model, args.keepImgs, args.embedImgs, args.dropImgs),
        }))
      );
      pages = resolvedPages;
    }
  }

  const { content, processedCount, warnings } = buildContent(pages, pageNumbers, args.toTxt, args.clean);
  for (const w of warnings) process.stderr.write(`  Warning: ${w}\n`);
  onStep?.("Writing output...");
  await fs.writeFile(outputPath, content, "utf-8");
  return { outputPath, pageCount: processedCount };
}
