import { Mistral } from "@mistralai/mistralai";
import { promises as fs } from "fs";
import * as path from "path";
import { CliArgs } from "./args.js";
import { resolveApiKey, markdownToText, cleanMarkdown } from "./utils.js";

/**
 * Calls client.ocr.process() with the given document URL and options.
 * Retries once without header/footer flags if the API version doesn't support them.
 */
async function runOcr(
  client: Mistral,
  documentUrl: string,
  model: string,
  extractHeader: boolean,
  extractFooter: boolean
): Promise<Awaited<ReturnType<typeof client.ocr.process>>> {
  const params: Record<string, unknown> = {
    document: { type: "document_url", documentUrl },
    model,
    includeImageBase64: false,
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

export async function processUrl(
  url: string,
  args: CliArgs,
  pageNumbers: Set<number> | null,
  outputPath: string
): Promise<{ outputPath: string; pageCount: number }> {
  const client = new Mistral({ apiKey: resolveApiKey(args.apiKey) });
  const response = await runOcr(client, url, args.model, args.extractHeader, args.extractFooter);
  const { content, processedCount, warnings } = buildContent(response.pages, pageNumbers, args.toTxt, args.clean);
  for (const w of warnings) process.stderr.write(`  Warning: ${w}\n`);
  await fs.writeFile(outputPath, content, "utf-8");
  return { outputPath, pageCount: processedCount };
}

export async function processPdf(
  pdfPath: string,
  args: CliArgs,
  pageNumbers: Set<number> | null,
  outputPath: string
): Promise<{ outputPath: string; pageCount: number }> {
  const client = new Mistral({ apiKey: resolveApiKey(args.apiKey) });
  const fileBytes = await fs.readFile(pdfPath);
  const uploaded = await client.files.upload({
    file: { fileName: path.basename(pdfPath), content: new Blob([fileBytes]) },
    purpose: "ocr" as Parameters<typeof client.files.upload>[0]["purpose"],
  });
  const signed = await client.files.getSignedUrl({ fileId: uploaded.id, expiry: 1 });
  const response = await runOcr(client, signed.url, args.model, args.extractHeader, args.extractFooter);
  const { content, processedCount, warnings } = buildContent(response.pages, pageNumbers, args.toTxt, args.clean);
  for (const w of warnings) process.stderr.write(`  Warning: ${w}\n`);
  await fs.writeFile(outputPath, content, "utf-8");
  return { outputPath, pageCount: processedCount };
}
