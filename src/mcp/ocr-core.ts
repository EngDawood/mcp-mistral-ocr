import { Mistral } from "@mistralai/mistralai";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import { parsePageSpec } from "../shared/utils.js";
import type { OcrResult } from "./schemas.js";

export const DEFAULT_MODEL = "mistral-ocr-latest";

export function getApiKey(): string {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    throw new Error(
      "MISTRAL_API_KEY not found. Set it as an environment variable or in a .env file."
    );
  }
  return apiKey;
}

export function expandPath(filePath: string): string {
  return filePath.startsWith("~")
    ? path.join(os.homedir(), filePath.slice(1))
    : path.resolve(filePath);
}

async function encodeImageToBase64(imagePath: string): Promise<string> {
  const mimeTypes: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
  };
  const ext = path.extname(imagePath).toLowerCase();
  const mimeType = mimeTypes[ext] ?? "image/png";
  const imageData = await fs.readFile(imagePath);
  return `data:${mimeType};base64,${Buffer.from(imageData).toString("base64")}`;
}

export function extractTablesFromPages(pages: any[], tableFormat: string): any[] {
  const tables: any[] = [];
  let tableId = 0;
  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const page = pages[pageIdx];
    if (!page.tables || page.tables.length === 0) continue;
    for (const table of page.tables) {
      const tableContent = (table as any)[tableFormat] ?? table.markdown ?? String(table);
      tables.push({ id: `tbl-${tableId}`, page: pageIdx + 1, content: tableContent, format: tableFormat });
      tableId++;
    }
  }
  return tables;
}

export function extractImagesFromPages(pages: any[]): any[] {
  const images: any[] = [];
  let imageId = 0;
  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const page = pages[pageIdx];
    if (!page.images || page.images.length === 0) continue;
    for (const img of page.images) {
      const imageInfo: any = { id: `img-${imageId}`, page: pageIdx + 1 };
      if (img.topLeftX !== undefined) {
        imageInfo.bbox = {
          top_left_x: img.topLeftX || 0,
          top_left_y: img.topLeftY || 0,
          bottom_right_x: img.bottomRightX || 0,
          bottom_right_y: img.bottomRightY || 0,
        };
      }
      if (img.imageBase64 !== undefined) imageInfo.has_base64 = Boolean(img.imageBase64);
      images.push(imageInfo);
      imageId++;
    }
  }
  return images;
}

export function extractHyperlinksFromContent(markdownContent: string): any[] {
  const pattern = /\[([^\]]+)\]\(([^\)]+)\)/g;
  const hyperlinks: any[] = [];
  let match;
  while ((match = pattern.exec(markdownContent)) !== null) {
    const [, text, url] = match;
    if (
      url.startsWith("data:image") ||
      [".png", ".jpg", ".jpeg", ".gif", ".webp"].some((ext) => url.toLowerCase().endsWith(ext))
    ) continue;
    hyperlinks.push({ text, url });
  }
  return hyperlinks;
}

export async function downloadPdfFromUrl(url: string, outputDir?: string): Promise<string> {
  const urlObj = new URL(url);
  let filename = path.basename(urlObj.pathname);
  if (!filename || !filename.toLowerCase().endsWith(".pdf")) {
    filename = "downloaded_document.pdf";
  }
  const dir = outputDir || os.tmpdir();
  const outputPath = path.join(dir, filename);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
  }
  await fs.writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
  return outputPath;
}

export async function processImageOcr(
  imageSource: string,
  sourceType: string,
  model: string = DEFAULT_MODEL
): Promise<[string, string[]]> {
  const client = new Mistral({ apiKey: getApiKey() });

  let imageUrl: string;
  if (sourceType === "url") {
    imageUrl = imageSource;
  } else if (sourceType === "file") {
    const imagePath = expandPath(imageSource);
    try { await fs.access(imagePath); } catch {
      throw new Error(`Image file not found: ${imageSource}`);
    }
    imageUrl = await encodeImageToBase64(imagePath);
  } else if (sourceType === "base64") {
    imageUrl = imageSource.startsWith("data:") ? imageSource : `data:image/png;base64,${imageSource}`;
  } else {
    throw new Error(`Invalid source_type: ${sourceType}`);
  }

  const response = await client.ocr.process({
    document: { type: "image_url", imageUrl },
    model,
    includeImageBase64: false,
  });

  const content = response.pages.map((page: any) => page.markdown).join("\n\n");
  return [content, []];
}

export async function processPdfOcr(
  pdfPath: string,
  model: string = DEFAULT_MODEL,
  pageNumbers?: Set<number>,
  extractHeader: boolean = true,
  extractFooter: boolean = true,
  tableFormat?: string,
  includeImages: boolean = false,
  includeHyperlinks: boolean = false
): Promise<OcrResult> {
  const client = new Mistral({ apiKey: getApiKey() });

  const fileBytes = await fs.readFile(pdfPath);
  const uploaded = await client.files.upload({
    file: { fileName: path.basename(pdfPath), content: new Blob([fileBytes]) },
    purpose: "ocr" as Parameters<typeof client.files.upload>[0]["purpose"],
  });
  const signed = await client.files.getSignedUrl({ fileId: uploaded.id!, expiry: 1 });

  const ocrParams: any = {
    document: { type: "document_url", documentUrl: signed.url },
    model,
    includeImageBase64: includeImages,
  };
  if (!extractHeader) ocrParams.extractHeader = false;
  if (!extractFooter) ocrParams.extractFooter = false;

  let response;
  try {
    response = await client.ocr.process(ocrParams);
  } catch (e: any) {
    if (e.message && (e.message.includes("extractHeader") || e.message.includes("extractFooter"))) {
      delete ocrParams.extractHeader;
      delete ocrParams.extractFooter;
      response = await client.ocr.process(ocrParams);
    } else {
      throw e;
    }
  }

  const warnings: string[] = [];
  const totalPages = response.pages.length;

  let markdownPages: string[];
  let pageObjects: any[];
  let pagesProcessed: number[];

  if (pageNumbers) {
    markdownPages = [];
    pageObjects = [];
    pagesProcessed = [];
    for (let idx = 0; idx < response.pages.length; idx++) {
      if (pageNumbers.has(idx + 1)) {
        markdownPages.push(response.pages[idx].markdown);
        pageObjects.push(response.pages[idx]);
        pagesProcessed.push(idx + 1);
      }
    }
    const invalidPages = Array.from(pageNumbers).filter((p) => p > totalPages);
    if (invalidPages.length > 0) {
      warnings.push(
        `Requested pages ${invalidPages.sort((a, b) => a - b).join(", ")} are out of range (PDF has ${totalPages} pages)`
      );
    }
  } else {
    markdownPages = response.pages.map((page: any) => page.markdown);
    pageObjects = Array.from(response.pages);
    pagesProcessed = Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  const markdownContent = markdownPages.join("\n\n");
  const result: OcrResult = { markdown_content: markdownContent, total_pages: totalPages, pages_processed: pagesProcessed, warnings };

  if (tableFormat) result.tables = extractTablesFromPages(pageObjects, tableFormat);
  if (includeImages) result.images = extractImagesFromPages(pageObjects);
  if (includeHyperlinks) result.hyperlinks = extractHyperlinksFromContent(markdownContent);

  return result;
}
