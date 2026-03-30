import { Mistral } from "@mistralai/mistralai";
import { promises as fs } from "fs";
import * as path from "path";
import {
  ProcessPdfInputSchema,
  ProcessUrlInputSchema,
  ProcessImageInputSchema,
  ExtractStructuredInputSchema,
  ExtractTablesInputSchema,
  CleanMarkdownInputSchema,
} from "./schemas.js";
import {
  DEFAULT_MODEL,
  processPdfOcr,
  processImageOcr,
  downloadPdfFromUrl,
  expandPath,
  getApiKey,
} from "./ocr-core.js";
import { markdownToText, cleanMarkdown, parsePageSpec, buildSchemaFromJson } from "../shared/utils.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(data: object): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(error: string, suggestion?: string): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ success: false, error, ...(suggestion && { suggestion }) }, null, 2) }],
    isError: true,
  };
}

// ─── Tool 1: Process local PDF ───────────────────────────────────────────────

export async function handleProcessPdf(args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const params = ProcessPdfInputSchema.parse(args);
    const pdfPath = expandPath(params.file_path);

    try { await fs.access(pdfPath); } catch {
      return err(`PDF file not found: ${params.file_path}`, "Please provide an absolute path to an existing PDF file.");
    }
    if (!pdfPath.toLowerCase().endsWith(".pdf")) {
      return err(`Expected a PDF file, got: ${path.extname(pdfPath)}`, "Ensure the file has a .pdf extension.");
    }

    let pageNumbers: Set<number> | undefined;
    if (params.pages) {
      try { pageNumbers = parsePageSpec(params.pages); }
      catch (e: any) { return err(`Invalid page specification: ${e.message}`, "Use format like '1,5,10-15' for page selection."); }
    }

    const ocrResult = await processPdfOcr(pdfPath, DEFAULT_MODEL, pageNumbers, params.extract_header, params.extract_footer, params.table_format, params.include_images, params.include_hyperlinks);
    let { markdown_content } = ocrResult;

    let cleaned = false;
    if (params.clean_output && params.output_format === "markdown") {
      markdown_content = cleanMarkdown(markdown_content);
      cleaned = true;
    }

    const finalContent = params.output_format === "text" ? markdownToText(markdown_content) : markdown_content;

    let outputFile: string | null = null;
    if (params.save_to_file) {
      const outputPath = pdfPath.replace(/\.pdf$/i, params.output_format === "text" ? ".txt" : ".md");
      await fs.writeFile(outputPath, finalContent, "utf-8");
      outputFile = outputPath;
    }

    const response: any = {
      success: true,
      content: params.return_content ? finalContent : null,
      page_count: ocrResult.total_pages,
      pages_processed: ocrResult.pages_processed,
      output_file: outputFile,
      format: params.output_format,
      cleaned,
      warnings: ocrResult.warnings,
    };
    if (params.table_format && ocrResult.tables) response.tables = ocrResult.tables;
    if (params.include_images && ocrResult.images) response.images = ocrResult.images;
    if (params.include_hyperlinks && ocrResult.hyperlinks) response.hyperlinks = ocrResult.hyperlinks;

    return ok(response);
  } catch (e: any) {
    return err(`Tool execution failed: ${e.message}`, "Check the input parameters and try again.");
  }
}

// ─── Tool 2: Process PDF from URL ────────────────────────────────────────────

export async function handleProcessUrl(args: Record<string, unknown>): Promise<ToolResult> {
  const params = ProcessUrlInputSchema.parse(args);
  let downloadedPdf: string | null = null;

  try {
    const outputDir = params.output_dir || process.cwd();
    await fs.mkdir(outputDir, { recursive: true });

    try { downloadedPdf = await downloadPdfFromUrl(params.url, outputDir); }
    catch (e: any) { return err(`Failed to download PDF: ${e.message}`, "Check the URL is accessible and points to a valid PDF."); }

    let pageNumbers: Set<number> | undefined;
    if (params.pages) {
      try { pageNumbers = parsePageSpec(params.pages); }
      catch (e: any) { return err(`Invalid page specification: ${e.message}`, "Use format like '1,5,10-15' for page selection."); }
    }

    const ocrResult = await processPdfOcr(downloadedPdf, DEFAULT_MODEL, pageNumbers, params.extract_header, params.extract_footer, params.table_format, params.include_images, params.include_hyperlinks);
    let { markdown_content } = ocrResult;

    let cleaned = false;
    if (params.clean_output && params.output_format === "markdown") {
      markdown_content = cleanMarkdown(markdown_content);
      cleaned = true;
    }

    const finalContent = params.output_format === "text" ? markdownToText(markdown_content) : markdown_content;
    const outputPath = downloadedPdf.replace(/\.pdf$/i, params.output_format === "text" ? ".txt" : ".md");
    await fs.writeFile(outputPath, finalContent, "utf-8");

    const pdfFile = params.keep_pdf ? downloadedPdf : null;
    if (!params.keep_pdf) await fs.unlink(downloadedPdf);

    const response: any = {
      success: true,
      content: params.return_content ? finalContent : null,
      page_count: ocrResult.total_pages,
      pages_processed: ocrResult.pages_processed,
      output_file: outputPath,
      pdf_file: pdfFile,
      format: params.output_format,
      cleaned,
      warnings: ocrResult.warnings,
    };
    if (params.table_format && ocrResult.tables) response.tables = ocrResult.tables;
    if (params.include_images && ocrResult.images) response.images = ocrResult.images;
    if (params.include_hyperlinks && ocrResult.hyperlinks) response.hyperlinks = ocrResult.hyperlinks;

    return ok(response);
  } catch (e: any) {
    if (downloadedPdf && !params.keep_pdf) {
      try { await fs.unlink(downloadedPdf); } catch { /* ignore */ }
    }
    return err(
      `Processing failed: ${e.message}`,
      e.message.includes("MISTRAL_API_KEY")
        ? "Check your MISTRAL_API_KEY environment variable."
        : "Ensure the URL points to a valid PDF file."
    );
  }
}

// ─── Tool 3: Process image ────────────────────────────────────────────────────

export async function handleProcessImage(args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const params = ProcessImageInputSchema.parse(args);
    const [rawContent, warnings] = await processImageOcr(params.image_source, params.source_type);

    let content = params.output_format === "text" ? markdownToText(rawContent) : rawContent;
    let cleaned = false;
    if (params.clean_output && params.output_format === "markdown") {
      content = cleanMarkdown(content);
      cleaned = true;
    }

    let outputFile: string | null = null;
    if (params.save_to_file) {
      const ext = params.output_format === "text" ? ".txt" : ".md";
      const outputPath = params.source_type === "file"
        ? expandPath(params.image_source).replace(/\.[^.]+$/, ext)
        : path.join(process.cwd(), `ocr_output${ext}`);
      await fs.writeFile(outputPath, content, "utf-8");
      outputFile = outputPath;
    }

    return ok({
      success: true,
      content: params.return_content ? content : null,
      output_file: outputFile,
      format: params.output_format,
      cleaned,
      warnings,
    });
  } catch (e: any) {
    return err(
      e.message.includes("not found") ? e.message : `Image OCR processing failed: ${e.message}`,
      e.message.includes("not found")
        ? "Check that the image file exists at the specified path."
        : e.message.includes("MISTRAL_API_KEY")
        ? "Check your MISTRAL_API_KEY environment variable or source_type parameter."
        : "Ensure the image is valid and in a supported format (PNG, JPG, etc.)."
    );
  }
}

// ─── Tool 4: Extract structured data ─────────────────────────────────────────

export async function handleExtractStructured(args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const params = ExtractStructuredInputSchema.parse(args);
    const filePath = expandPath(params.file_path);

    try { await fs.access(filePath); } catch {
      return err(`File not found: ${params.file_path}`, "Please provide an absolute path to an existing file.");
    }

    let schema: Record<string, any>;
    try { schema = buildSchemaFromJson(params.json_schema); }
    catch (e: any) { return err(e.message, "Ensure json_schema is valid JSON schema format."); }

    let pageNumbers: Set<number> | undefined;
    if (params.pages) {
      try {
        pageNumbers = parsePageSpec(params.pages);
        if (pageNumbers.size > 8) {
          return err(`Document annotation is limited to 8 pages (requested ${pageNumbers.size})`, "Use pages parameter to select 8 or fewer pages.");
        }
      } catch (e: any) {
        return err(`Invalid page specification: ${e.message}`, "Use format like '1,5-8' for page selection.");
      }
    }

    const client = new Mistral({ apiKey: getApiKey() });
    const warnings: string[] = [];
    const ext = path.extname(filePath).toLowerCase();

    let document: any;
    if (ext === ".pdf") {
      const fileBytes = await fs.readFile(filePath);
      const uploaded = await client.files.upload({
        file: { fileName: path.basename(filePath), content: new Blob([fileBytes]) },
        purpose: "ocr" as Parameters<typeof client.files.upload>[0]["purpose"],
      });
      const signed = await client.files.getSignedUrl({ fileId: uploaded.id!, expiry: 1 });
      document = { type: "document_url", documentUrl: signed.url };
    } else {
      const fileBytes = await fs.readFile(filePath);
      const mimeTypes: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
      const mimeType = mimeTypes[ext] ?? "image/png";
      document = { type: "image_url", imageUrl: `data:${mimeType};base64,${Buffer.from(fileBytes).toString("base64")}` };
    }

    const ocrParams: any = {
      document,
      model: DEFAULT_MODEL,
      includeImageBase64: params.include_images,
      ...(params.annotation_type === "document" && { documentAnnotationFormat: schema }),
      ...(pageNumbers && { pages: Array.from(pageNumbers) }),
    };

    let response;
    try {
      response = await client.ocr.process(ocrParams);
    } catch (e: any) {
      if (e.message?.includes("documentAnnotationFormat")) {
        warnings.push("Document annotation format not supported in current API version");
        delete ocrParams.documentAnnotationFormat;
        response = await client.ocr.process(ocrParams);
      } else {
        throw e;
      }
    }

    const totalPages = response.pages?.length ?? 0;
    let pagesProcessed = Array.from({ length: totalPages }, (_, i) => i + 1);
    if (pageNumbers && totalPages > 8) {
      warnings.push(`Document has ${totalPages} pages but only first 8 were processed for annotation`);
      pagesProcessed = pagesProcessed.slice(0, 8);
    }

    return ok({
      success: true,
      extracted_data: (response as any).documentAnnotation ?? (response as any).annotations ?? null,
      page_count: totalPages,
      pages_processed: pagesProcessed,
      schema_used: params.json_schema,
      warnings,
    });
  } catch (e: any) {
    return err(
      e.message.includes("MISTRAL_API_KEY") ? e.message : `Structured extraction failed: ${e.message}`,
      e.message.includes("MISTRAL_API_KEY") ? "Check your MISTRAL_API_KEY environment variable." : "Ensure the file is valid and the schema is correct."
    );
  }
}

// ─── Tool 5: Extract tables ───────────────────────────────────────────────────

export async function handleExtractTables(args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const params = ExtractTablesInputSchema.parse(args);
    const pdfPath = expandPath(params.file_path);

    try { await fs.access(pdfPath); } catch {
      return err(`PDF file not found: ${params.file_path}`, "Please provide an absolute path to an existing PDF file.");
    }
    if (!pdfPath.toLowerCase().endsWith(".pdf")) {
      return err(`Expected a PDF file, got: ${path.extname(pdfPath)}`, "Ensure the file has a .pdf extension.");
    }

    let pageNumbers: Set<number> | undefined;
    if (params.pages) {
      try { pageNumbers = parsePageSpec(params.pages); }
      catch (e: any) { return err(`Invalid page specification: ${e.message}`, "Use format like '1,5,10-15' for page selection."); }
    }

    const ocrResult = await processPdfOcr(pdfPath, DEFAULT_MODEL, pageNumbers, true, true, params.table_format);
    const tables = ocrResult.tables ?? [];

    let outputFile: string | null = null;
    if (params.save_to_file && tables.length > 0) {
      const ext = params.table_format === "html" ? ".html" : ".md";
      const outputPath = path.join(path.dirname(pdfPath), `${path.basename(pdfPath, ".pdf")}_tables${ext}`);
      const tableContent = tables
        .map((t: any) =>
          params.table_format === "html"
            ? `<!-- Table ${t.id} from page ${t.page} -->\n${t.content}`
            : `## Table ${t.id} (Page ${t.page})\n\n${t.content}`
        )
        .join("\n\n");
      await fs.writeFile(outputPath, tableContent, "utf-8");
      outputFile = outputPath;
    }

    const response: any = {
      success: true,
      table_count: tables.length,
      page_count: ocrResult.total_pages,
      pages_processed: ocrResult.pages_processed,
      output_file: outputFile,
      format: params.table_format,
      warnings: ocrResult.warnings,
    };
    if (params.return_content) response.tables = tables;

    return ok(response);
  } catch (e: any) {
    return err(
      e.message.includes("MISTRAL_API_KEY") ? e.message : `Table extraction failed: ${e.message}`,
      e.message.includes("MISTRAL_API_KEY") ? "Check your MISTRAL_API_KEY environment variable." : "Ensure the PDF is valid and contains tables."
    );
  }
}

// ─── Tool 6: Clean markdown ───────────────────────────────────────────────────

export async function handleCleanMarkdown(args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const params = CleanMarkdownInputSchema.parse(args);
    const cleanedContent = cleanMarkdown(params.content);
    return ok({
      success: true,
      content: cleanedContent,
      original_length: params.content.length,
      cleaned_length: cleanedContent.length,
      reduction_percent: params.content.length > 0
        ? Math.round((1 - cleanedContent.length / params.content.length) * 1000) / 10
        : 0,
    });
  } catch (e: any) {
    return err(`Cleaning failed: ${e.message}`, "Ensure the content is valid markdown text.");
  }
}
