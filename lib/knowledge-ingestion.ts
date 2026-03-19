import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";
import * as cheerio from "cheerio";
import JSZip from "jszip";
import mammoth from "mammoth";
import PDFDocument from "pdfkit";
import { PDFParse } from "pdf-parse";
import { PSTFile, type PSTFolder, type PSTMessage } from "pst-extractor";
import TurndownService from "turndown";
import { createWorker } from "tesseract.js";
import * as XLSX from "xlsx";

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

const STORAGE_ROOT = path.join(process.cwd(), "storage", "jobs");
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".log", ".rtf"]);
const HTML_EXTENSIONS = new Set([".html", ".htm"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff"]);
const SHEET_EXTENSIONS = new Set([".csv", ".tsv", ".xlsx", ".xls"]);
const MAX_PDF_SUMMARY_MESSAGES = 500;
const MAX_PDF_BODY_PREVIEW = 800;

type SourceKind = "upload" | "url" | "archive-entry" | "local-path";

export type JobInput = {
  files: Array<{ name: string; bytes: Buffer; relativePath?: string; mimeType?: string }>;
  urls: string[];
  paths: string[];
};

type SourceDocument = {
  sourceKind: SourceKind;
  name: string;
  relativePath: string;
  bytes?: Buffer;
  mimeType?: string;
  sourceUrl?: string;
  localPath?: string;
  sizeBytes?: number;
};

type ProcessedRecord = {
  source: string;
  markdownPath?: string;
  sourceUrl?: string;
  status: "processed" | "skipped" | "failed";
  extractor: string;
  sizeBytes: number;
  error?: string;
  outputFiles?: string[];
};

export type JobResult = {
  jobId: string;
  createdAt: string;
  inputCount: number;
  processedCount: number;
  failedCount: number;
  outputDirectory: string;
  zipPath: string;
  zipUrl: string;
  manifestPath: string;
  summaryPath: string;
  records: ProcessedRecord[];
};

type JobContext = {
  jobId: string;
  rootDir: string;
  markdownDir: string;
  rawDir: string;
  records: ProcessedRecord[];
};

type PstStats = {
  storeName: string;
  folders: number;
  messages: number;
  attachments: number;
  pdfMessages: number;
  pdfTruncated: boolean;
};

export async function runKnowledgeIngestion(input: JobInput): Promise<JobResult> {
  const jobId = new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8);
  const rootDir = path.join(STORAGE_ROOT, jobId);
  const markdownDir = path.join(rootDir, "markdown");
  const rawDir = path.join(rootDir, "raw");
  await mkdir(markdownDir, { recursive: true });
  await mkdir(rawDir, { recursive: true });

  const ctx: JobContext = { jobId, rootDir, markdownDir, rawDir, records: [] };
  const sources = [
    ...input.files.map<SourceDocument>((file) => ({
      sourceKind: "upload",
      name: file.name,
      relativePath: normalizeRelativePath(file.relativePath || file.name),
      bytes: file.bytes,
      mimeType: file.mimeType,
      sizeBytes: file.bytes.length
    })),
    ...(await collectUrlSources(input.urls)),
    ...(await collectLocalPathSources(input.paths))
  ];

  for (const source of sources) {
    await processSource(source, ctx);
  }

  const summaryPath = path.join(markdownDir, "README.md");
  await writeFile(summaryPath, buildSummaryMarkdown(ctx.records, jobId), "utf8");

  const manifestPath = path.join(rootDir, "manifest.json");
  const result: JobResult = {
    jobId,
    createdAt: new Date().toISOString(),
    inputCount: sources.length,
    processedCount: ctx.records.filter((record) => record.status === "processed").length,
    failedCount: ctx.records.filter((record) => record.status === "failed").length,
    outputDirectory: markdownDir,
    zipPath: path.join(rootDir, `${jobId}-markdown.zip`),
    zipUrl: `/api/exports/${jobId}`,
    manifestPath,
    summaryPath,
    records: ctx.records
  };

  await writeFile(manifestPath, JSON.stringify(result, null, 2), "utf8");
  await writeExportZip(markdownDir, result.zipPath);
  return result;
}

async function collectUrlSources(urls: string[]): Promise<SourceDocument[]> {
  const out: SourceDocument[] = [];
  for (const rawUrl of urls) {
    const url = rawUrl.trim();
    if (!url) {
      continue;
    }

    if (isGoogleDriveFolderUrl(url)) {
      out.push(...(await crawlGoogleDriveFolder(url)));
      continue;
    }

    out.push(await downloadRemoteSource(url));
  }
  return out;
}

async function collectLocalPathSources(pathsInput: string[]): Promise<SourceDocument[]> {
  const out: SourceDocument[] = [];
  for (const rawValue of pathsInput) {
    const localPath = rawValue.trim().replace(/^"(.*)"$/, "$1");
    if (!localPath) {
      continue;
    }

    const info = await stat(localPath);
    if (info.isDirectory()) {
      out.push(...(await collectDirectorySources(localPath, path.basename(localPath))));
      continue;
    }

    out.push({
      sourceKind: "local-path",
      name: path.basename(localPath),
      relativePath: normalizeRelativePath(path.basename(localPath)),
      localPath,
      sizeBytes: info.size
    });
  }
  return out;
}

async function collectDirectorySources(rootPath: string, relativeRoot: string): Promise<SourceDocument[]> {
  const out: SourceDocument[] = [];
  const entries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootPath, entry.name);
    const relativePath = normalizeRelativePath(path.join(relativeRoot, entry.name));
    if (entry.isDirectory()) {
      out.push(...(await collectDirectorySources(fullPath, relativePath)));
      continue;
    }
    const info = await stat(fullPath);
    out.push({
      sourceKind: "local-path",
      name: entry.name,
      relativePath,
      localPath: fullPath,
      sizeBytes: info.size
    });
  }
  return out;
}

async function processSource(source: SourceDocument, ctx: JobContext): Promise<void> {
  const sourceLabel = source.localPath ? `${source.relativePath} (${source.localPath})` : source.relativePath || source.name;
  try {
    const ext = path.extname(source.name).toLowerCase();

    if (ext === ".pst") {
      const pstPath = source.localPath ?? (await writeRawCopy(source, await ensureSourceBytes(source), ctx));
      const pstOutputs = await processPstSource(pstPath, source, ctx);
      ctx.records.push({
        source: sourceLabel,
        sourceUrl: source.sourceUrl,
        markdownPath: pstOutputs.markdownPath,
        outputFiles: pstOutputs.outputFiles,
        status: "processed",
        extractor: "pst-mailbox",
        sizeBytes: source.sizeBytes ?? 0
      });
      return;
    }

    const bytes = await ensureSourceBytes(source);
    await writeRawCopy(source, bytes, ctx);

    if (ext === ".zip") {
      await unpackZip(source, bytes, ctx);
      ctx.records.push({
        source: sourceLabel,
        sourceUrl: source.sourceUrl,
        status: "processed",
        extractor: "zip-recursion",
        sizeBytes: bytes.length
      });
      return;
    }

    const { markdown, extractor } = await convertToMarkdown({ ...source, bytes });
    const markdownPath = path.join(ctx.markdownDir, replaceExtension(source.relativePath, ".md"));
    await mkdir(path.dirname(markdownPath), { recursive: true });
    await writeFile(markdownPath, decorateMarkdown(source, markdown, extractor), "utf8");
    ctx.records.push({
      source: sourceLabel,
      sourceUrl: source.sourceUrl,
      markdownPath,
      status: "processed",
      extractor,
      sizeBytes: bytes.length
    });
  } catch (error) {
    ctx.records.push({
      source: sourceLabel,
      sourceUrl: source.sourceUrl,
      status: "failed",
      extractor: "error",
      sizeBytes: source.sizeBytes ?? source.bytes?.length ?? 0,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function ensureSourceBytes(source: SourceDocument): Promise<Buffer> {
  if (source.bytes) {
    return source.bytes;
  }
  if (source.localPath) {
    const bytes = await readFile(source.localPath);
    source.bytes = bytes;
    source.sizeBytes = bytes.length;
    return bytes;
  }
  throw new Error(`No bytes available for ${source.name}`);
}

async function writeRawCopy(source: SourceDocument, bytes: Buffer, ctx: JobContext): Promise<string> {
  const rawPath = path.join(ctx.rawDir, source.relativePath);
  await mkdir(path.dirname(rawPath), { recursive: true });

  if (source.localPath && source.sizeBytes && source.sizeBytes > 64 * 1024 * 1024) {
    await copyFile(source.localPath, rawPath);
    return rawPath;
  }

  await writeFile(rawPath, bytes);
  return rawPath;
}

async function unpackZip(source: SourceDocument, bytes: Buffer, ctx: JobContext): Promise<void> {
  const zip = await JSZip.loadAsync(bytes);
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  for (const entry of entries) {
    const childBytes = await entry.async("nodebuffer");
    await processSource(
      {
        sourceKind: "archive-entry",
        name: path.basename(entry.name),
        relativePath: normalizeRelativePath(path.join(stripExtension(source.relativePath), entry.name)),
        bytes: childBytes,
        sourceUrl: source.sourceUrl,
        sizeBytes: childBytes.length
      },
      ctx
    );
  }
}

async function processPstSource(pstPath: string, source: SourceDocument, ctx: JobContext) {
  const baseRelative = stripExtension(source.relativePath);
  const markdownPath = path.join(ctx.markdownDir, `${baseRelative}.md`);
  const htmlPath = path.join(ctx.markdownDir, `${baseRelative}.html`);
  const jsonPath = path.join(ctx.markdownDir, `${baseRelative}.mailbox.json`);
  const pdfPath = path.join(ctx.markdownDir, `${baseRelative}.summary.pdf`);

  await mkdir(path.dirname(markdownPath), { recursive: true });
  await mkdir(path.dirname(htmlPath), { recursive: true });

  const markdownStream = createWriteStream(markdownPath, { encoding: "utf8" });
  const htmlStream = createWriteStream(htmlPath, { encoding: "utf8" });
  const pdfStream = createWriteStream(pdfPath);
  const pdfDoc = new PDFDocument({ autoFirstPage: true, margin: 42 });
  pdfDoc.pipe(pdfStream);

  const stats: PstStats = {
    storeName: source.name,
    folders: 0,
    messages: 0,
    attachments: 0,
    pdfMessages: 0,
    pdfTruncated: false
  };

  writePstOpeners(markdownStream, htmlStream, pdfDoc, source);

  const pst = new PSTFile(pstPath);
  try {
    stats.storeName = safeText(readProp(pst.getMessageStore(), "displayName")) || source.name;
    markdownStream.write(`- Mailbox: ${stats.storeName}\n`);
    if (source.localPath) {
      markdownStream.write(`- Local path: ${source.localPath}\n`);
    }
    markdownStream.write("\n");

    htmlStream.write(`<p><strong>Mailbox:</strong> ${escapeHtml(stats.storeName)}</p>`);
    if (source.localPath) {
      htmlStream.write(`<p><strong>Local path:</strong> ${escapeHtml(source.localPath)}</p>`);
    }

    pdfDoc.fontSize(11).fillColor("#111827").text(`Mailbox: ${stats.storeName}`);
    if (source.localPath) {
      pdfDoc.text(`Local path: ${source.localPath}`);
    }
    pdfDoc.moveDown();

    processPstFolder(pst.getRootFolder(), [], markdownStream, htmlStream, pdfDoc, stats);
  } finally {
    pst.close();
  }

  markdownStream.write(`\n## Mailbox Summary\n\n- Folders: ${stats.folders}\n- Messages: ${stats.messages}\n- Attachments referenced: ${stats.attachments}\n`);
  if (stats.pdfTruncated) {
    markdownStream.write("- PDF summary was capped for performance; full content remains in Markdown and HTML.\n");
  }
  markdownStream.write("\n");
  markdownStream.end();

  htmlStream.write(`<section class="summary"><h2>Mailbox Summary</h2><ul><li>Folders: ${stats.folders}</li><li>Messages: ${stats.messages}</li><li>Attachments referenced: ${stats.attachments}</li>${stats.pdfTruncated ? "<li>PDF summary was capped for performance; full content remains in Markdown and HTML.</li>" : ""}</ul></section></body></html>`);
  htmlStream.end();

  writePstPdfSummary(pdfDoc, stats);
  pdfDoc.end();

  await Promise.all([finished(markdownStream), finished(htmlStream), finished(pdfStream)]);

  await writeFile(
    jsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: source.localPath ?? source.name,
        storeName: stats.storeName,
        folders: stats.folders,
        messages: stats.messages,
        attachments: stats.attachments,
        pdfMessages: stats.pdfMessages,
        pdfTruncated: stats.pdfTruncated
      },
      null,
      2
    ),
    "utf8"
  );

  return {
    markdownPath,
    outputFiles: [markdownPath, htmlPath, jsonPath, pdfPath]
  };
}

function processPstFolder(
  folder: PSTFolder,
  parentPath: string[],
  markdownStream: NodeJS.WritableStream,
  htmlStream: NodeJS.WritableStream,
  pdfDoc: PDFKit.PDFDocument,
  stats: PstStats
) {
  const folderName = safeText(readProp(folder, "displayName")) || "Root";
  const currentPath = [...parentPath, folderName];
  const visiblePath = currentPath.join(" / ");
  stats.folders += 1;

  markdownStream.write(`## Folder: ${visiblePath}\n\n`);
  htmlStream.write(`<section class="folder"><h2>${escapeHtml(visiblePath)}</h2>`);

  pdfDoc.fontSize(13).fillColor("#0f172a").text(`Folder: ${visiblePath}`);
  pdfDoc.moveDown(0.2);

  let child = folder.getNextChild() as PSTMessage | null;
  while (child) {
    processPstMessage(child, visiblePath, markdownStream, htmlStream, pdfDoc, stats);
    child = folder.getNextChild() as PSTMessage | null;
  }

  htmlStream.write(`</section>`);

  if (folder.hasSubfolders) {
    for (const childFolder of folder.getSubFolders()) {
      processPstFolder(childFolder, currentPath, markdownStream, htmlStream, pdfDoc, stats);
    }
  }
}

function processPstMessage(
  message: PSTMessage,
  folderPath: string,
  markdownStream: NodeJS.WritableStream,
  htmlStream: NodeJS.WritableStream,
  pdfDoc: PDFKit.PDFDocument,
  stats: PstStats
) {
  stats.messages += 1;

  const subject = safeText(message.subject) || "(no subject)";
  const senderName = safeText(message.senderName);
  const senderEmail = safeText(message.senderEmailAddress);
  const sender = senderName && senderEmail ? `${senderName} <${senderEmail}>` : senderName || senderEmail;
  const to = safeText(message.displayTo);
  const cc = safeText(message.displayCC);
  const sentAt = formatMaybeDate(readProp(message, "clientSubmitTime") ?? readProp(message, "messageDeliveryTime"));
  const body = extractPstBody(message);
  const attachments = extractPstAttachments(message);
  stats.attachments += attachments.length;

  markdownStream.write(`### ${subject}\n\n`);
  markdownStream.write(`- Folder: ${folderPath}\n`);
  if (sender) markdownStream.write(`- From: ${sender}\n`);
  if (to) markdownStream.write(`- To: ${to}\n`);
  if (cc) markdownStream.write(`- Cc: ${cc}\n`);
  if (sentAt) markdownStream.write(`- Date: ${sentAt}\n`);
  markdownStream.write(`- Attachments: ${attachments.length}\n\n`);

  if (attachments.length) {
    markdownStream.write("Attachments:\n");
    for (const attachment of attachments) {
      markdownStream.write(`- ${attachment.name} (${attachment.sizeLabel})\n`);
    }
    markdownStream.write("\n");
  }

  markdownStream.write(body ? `${body}\n\n---\n\n` : "_No readable body extracted._\n\n---\n\n");

  htmlStream.write(`<article class="message"><h3>${escapeHtml(subject)}</h3><ul>`);
  htmlStream.write(`<li><strong>Folder:</strong> ${escapeHtml(folderPath)}</li>`);
  if (sender) htmlStream.write(`<li><strong>From:</strong> ${escapeHtml(sender)}</li>`);
  if (to) htmlStream.write(`<li><strong>To:</strong> ${escapeHtml(to)}</li>`);
  if (cc) htmlStream.write(`<li><strong>Cc:</strong> ${escapeHtml(cc)}</li>`);
  if (sentAt) htmlStream.write(`<li><strong>Date:</strong> ${escapeHtml(sentAt)}</li>`);
  htmlStream.write(`<li><strong>Attachments:</strong> ${attachments.length}</li></ul>`);
  if (attachments.length) {
    htmlStream.write("<p><strong>Attachments</strong></p><ul>");
    for (const attachment of attachments) {
      htmlStream.write(`<li>${escapeHtml(attachment.name)} (${escapeHtml(attachment.sizeLabel)})</li>`);
    }
    htmlStream.write("</ul>");
  }
  htmlStream.write(`<pre>${escapeHtml(body || "No readable body extracted.")}</pre></article>`);

  if (stats.pdfMessages < MAX_PDF_SUMMARY_MESSAGES) {
    stats.pdfMessages += 1;
    pdfDoc.fontSize(11).fillColor("#111827").text(subject);
    pdfDoc.fontSize(9).fillColor("#374151");
    if (sender) pdfDoc.text(`From: ${sender}`);
    if (sentAt) pdfDoc.text(`Date: ${sentAt}`);
    pdfDoc.text(`Folder: ${folderPath}`);
    pdfDoc.text(`Attachments: ${attachments.length}`);
    if (body) {
      pdfDoc.text(trimForPdf(body), { width: 520 });
    }
    pdfDoc.moveDown();
  } else {
    stats.pdfTruncated = true;
  }
}

function extractPstBody(message: PSTMessage): string {
  const htmlBody = safeText(message.bodyHTML);
  if (htmlBody) {
    const asMarkdown = normalizeText(turndown.turndown(htmlBody));
    if (asMarkdown) {
      return asMarkdown;
    }
  }
  return normalizeText(safeText(message.body) || safeText(message.bodyRTF));
}

function extractPstAttachments(message: PSTMessage) {
  const attachments: Array<{ name: string; sizeLabel: string }> = [];
  const count = Number(message.numberOfAttachments || 0);
  for (let index = 0; index < count; index += 1) {
    try {
      const attachment = message.getAttachment(index);
      const name = safeText(attachment.longFilename) || safeText(attachment.filename) || `attachment-${index + 1}`;
      attachments.push({
        name,
        sizeLabel: formatBytes(Number(attachment.filesize || attachment.size || 0))
      });
    } catch {
      attachments.push({ name: `attachment-${index + 1}`, sizeLabel: "unknown size" });
    }
  }
  return attachments;
}

async function convertToMarkdown(source: SourceDocument & { bytes: Buffer }): Promise<{ markdown: string; extractor: string }> {
  const ext = path.extname(source.name).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) {
    return { markdown: source.bytes.toString("utf8"), extractor: "plain-text" };
  }

  if (HTML_EXTENSIONS.has(ext)) {
    return { markdown: turndown.turndown(source.bytes.toString("utf8")), extractor: "html-to-markdown" };
  }

  if (ext === ".json") {
    const formatted = JSON.stringify(JSON.parse(source.bytes.toString("utf8")), null, 2);
    return { markdown: `\`\`\`json\n${formatted}\n\`\`\``, extractor: "json" };
  }

  if (SHEET_EXTENSIONS.has(ext)) {
    return { markdown: workbookToMarkdown(source.bytes, ext), extractor: "spreadsheet" };
  }

  if (ext === ".pdf") {
    const parser = new PDFParse({ data: source.bytes });
    try {
      const parsed = await parser.getText();
      return { markdown: normalizeText(parsed.text), extractor: "pdf-text" };
    } finally {
      await parser.destroy();
    }
  }

  if (ext === ".docx") {
    const parsed = await mammoth.extractRawText({ buffer: source.bytes });
    return { markdown: normalizeText(parsed.value), extractor: "docx-text" };
  }

  if (IMAGE_EXTENSIONS.has(ext)) {
    const markdown = await imageToMarkdown(source.bytes);
    return { markdown, extractor: "ocr" };
  }

  if (ext === ".eml") {
    return { markdown: normalizeText(source.bytes.toString("utf8")), extractor: "email-raw" };
  }

  return {
    markdown: [
      "Unsupported file type for full text extraction.",
      "",
      `- Original name: ${source.name}`,
      `- Extension: ${ext || "unknown"}`,
      `- Bytes: ${source.bytes.length}`
    ].join("\n"),
    extractor: "fallback"
  };
}

function workbookToMarkdown(bytes: Buffer, extension: string): string {
  const workbook = XLSX.read(bytes, { type: "buffer" });
  const lines: string[] = [];
  for (const sheetName of workbook.SheetNames) {
    lines.push(`## ${sheetName}`);
    lines.push("");
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<(string | number | boolean | null)[]>(sheet, {
      header: 1,
      raw: false,
      defval: ""
    });

    if (!rows.length) {
      lines.push("_No rows found._", "");
      continue;
    }

    const normalized = rows.map((row) => row.map((cell) => escapeMarkdownTable(String(cell ?? ""))));
    const width = Math.max(...normalized.map((row) => row.length));
    const padded = normalized.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? ""));
    const header = padded[0];
    lines.push(`| ${header.join(" | ")} |`);
    lines.push(`| ${header.map(() => "---").join(" | ")} |`);
    for (const row of padded.slice(1)) {
      lines.push(`| ${row.join(" | ")} |`);
    }
    lines.push("");
  }
  if (!lines.length) {
    return `No readable worksheet content found in ${extension}.`;
  }
  return lines.join("\n");
}

async function imageToMarkdown(bytes: Buffer): Promise<string> {
  const worker = await createWorker("eng");
  try {
    const { data } = await worker.recognize(bytes);
    const text = normalizeText(data.text);
    return text || "_OCR completed but no readable text was detected._";
  } finally {
    await worker.terminate();
  }
}

function decorateMarkdown(source: SourceDocument, body: string, extractor: string): string {
  const lines = [
    `# ${source.name}`,
    "",
    `- Source kind: ${source.sourceKind}`,
    `- Relative path: ${source.relativePath}`
  ];
  if (source.sourceUrl) {
    lines.push(`- Source URL: ${source.sourceUrl}`);
  }
  if (source.localPath) {
    lines.push(`- Local path: ${source.localPath}`);
  }
  lines.push(`- Extractor: ${extractor}`, "", body.trim() || "_No text extracted._", "");
  return lines.join("\n");
}

async function downloadRemoteSource(url: string): Promise<SourceDocument> {
  if (isGoogleDriveFileUrl(url)) {
    return downloadGoogleDriveFile(url);
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Unable to download ${url}: ${response.status}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") || undefined;
  const filename = inferRemoteFilename(url, response.headers.get("content-disposition"), contentType);

  return {
    sourceKind: "url",
    name: filename,
    relativePath: normalizeRelativePath(filename),
    bytes,
    mimeType: contentType,
    sourceUrl: url,
    sizeBytes: bytes.length
  };
}

async function crawlGoogleDriveFolder(url: string, visited = new Set<string>()): Promise<SourceDocument[]> {
  const folderId = extractGoogleDriveFolderId(url);
  if (!folderId || visited.has(folderId)) {
    return [];
  }
  visited.add(folderId);

  const response = await fetch(`https://drive.google.com/embeddedfolderview?id=${folderId}#list`);
  if (!response.ok) {
    throw new Error(`Unable to open Google Drive folder ${url}: ${response.status}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);
  const links = $("a")
    .map((_, element) => ({
      href: $(element).attr("href"),
      text: $(element).text().trim()
    }))
    .get()
    .filter((link) => Boolean(link.href));

  const out: SourceDocument[] = [];
  for (const link of links) {
    const href = absolutizeDriveUrl(link.href!);
    if (isGoogleDriveFolderUrl(href)) {
      out.push(...(await crawlGoogleDriveFolder(href, visited)));
      continue;
    }

    if (isGoogleDriveFileUrl(href)) {
      const file = await downloadGoogleDriveFile(href, link.text || undefined);
      out.push(file);
    }
  }
  return out;
}

async function downloadGoogleDriveFile(url: string, preferredName?: string): Promise<SourceDocument> {
  const fileId = extractGoogleDriveFileId(url);
  if (!fileId) {
    throw new Error(`Could not determine Google Drive file id from ${url}`);
  }

  let response = await fetch(`https://drive.google.com/uc?export=download&id=${fileId}`);
  let text = response.headers.get("content-type")?.includes("text/html") ? await response.text() : null;

  if (text?.includes("confirm=")) {
    const confirmMatch = text.match(/confirm=([0-9A-Za-z_]+)&amp;id=/);
    const confirm = confirmMatch?.[1];
    if (confirm) {
      response = await fetch(`https://drive.google.com/uc?export=download&confirm=${confirm}&id=${fileId}`);
      text = null;
    }
  }

  if (!response.ok) {
    throw new Error(`Unable to download Google Drive file ${url}: ${response.status}`);
  }

  const bytes = text === null ? Buffer.from(await response.arrayBuffer()) : Buffer.from(text, "utf8");
  const contentType = response.headers.get("content-type") || undefined;
  const name =
    preferredName ||
    inferRemoteFilename(
      url,
      response.headers.get("content-disposition"),
      contentType,
      `drive-${fileId}${guessExtensionFromType(contentType)}`
    );

  return {
    sourceKind: "url",
    name,
    relativePath: normalizeRelativePath(name),
    bytes,
    mimeType: contentType,
    sourceUrl: url,
    sizeBytes: bytes.length
  };
}

async function writeExportZip(markdownDir: string, zipPath: string): Promise<void> {
  const zip = new JSZip();
  await addDirectoryToZip(zip, markdownDir, markdownDir);
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await writeFile(zipPath, bytes);
}

async function addDirectoryToZip(zip: JSZip, rootDir: string, currentDir: string): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await addDirectoryToZip(zip, rootDir, fullPath);
      continue;
    }
    const relativeName = path.relative(rootDir, fullPath).replaceAll("\\", "/");
    zip.file(relativeName, await readFile(fullPath));
  }
}

function buildSummaryMarkdown(records: ProcessedRecord[], jobId: string): string {
  const processed = records.filter((record) => record.status === "processed").length;
  const failed = records.filter((record) => record.status === "failed").length;
  const lines = [
    `# Knowledge Ingestion ${jobId}`,
    "",
    `- Processed files: ${processed}`,
    `- Failed files: ${failed}`,
    "",
    "## Results",
    ""
  ];

  for (const record of records) {
    const bits = [`- ${record.status.toUpperCase()} :: ${record.source}`, `Extractor: ${record.extractor}`];
    if (record.markdownPath) {
      bits.push(`Markdown: ${record.markdownPath}`);
    }
    if (record.outputFiles?.length) {
      bits.push(`Outputs: ${record.outputFiles.length}`);
    }
    if (record.error) {
      bits.push(`Error: ${record.error}`);
    }
    lines.push(bits.join(" | "));
  }

  if (records.length === 0) {
    lines.push("_No files were ingested._");
  }

  lines.push("");
  return lines.join("\n");
}

function writePstOpeners(
  markdownStream: NodeJS.WritableStream,
  htmlStream: NodeJS.WritableStream,
  pdfDoc: PDFKit.PDFDocument,
  source: SourceDocument
) {
  markdownStream.write(`# ${source.name}\n\n`);
  markdownStream.write(`- Source kind: ${source.sourceKind}\n`);
  markdownStream.write(`- Relative path: ${source.relativePath}\n`);
  if (source.sourceUrl) {
    markdownStream.write(`- Source URL: ${source.sourceUrl}\n`);
  }

  htmlStream.write(`<!doctype html><html><head><meta charset="utf-8" /><title>${escapeHtml(source.name)}</title><style>
    body { font-family: Georgia, 'Times New Roman', serif; margin: 2rem auto; max-width: 960px; color: #111827; background: #fffdf8; }
    h1, h2, h3 { color: #111827; }
    section.folder { margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 1px solid #e5e7eb; }
    article.message { margin: 1rem 0; padding: 1rem; background: #ffffff; border: 1px solid #e5e7eb; border-radius: 16px; }
    pre { white-space: pre-wrap; word-break: break-word; background: #f8fafc; padding: 1rem; border-radius: 12px; }
    ul { padding-left: 1.2rem; }
  </style></head><body><h1>${escapeHtml(source.name)}</h1>`);

  pdfDoc.fontSize(18).fillColor("#111827").text(source.name);
  pdfDoc.moveDown(0.5);
}

function writePstPdfSummary(pdfDoc: PDFKit.PDFDocument, stats: PstStats) {
  pdfDoc.addPage();
  pdfDoc.fontSize(18).fillColor("#111827").text("Mailbox Summary");
  pdfDoc.moveDown();
  pdfDoc.fontSize(11).fillColor("#374151").text(`Mailbox: ${stats.storeName}`);
  pdfDoc.text(`Folders: ${stats.folders}`);
  pdfDoc.text(`Messages: ${stats.messages}`);
  pdfDoc.text(`Attachments referenced: ${stats.attachments}`);
  pdfDoc.text(`Messages detailed in this PDF: ${stats.pdfMessages}`);
  if (stats.pdfTruncated) {
    pdfDoc.moveDown();
    pdfDoc.fillColor("#991b1b").text("The PDF was intentionally capped for performance. Full mailbox text is in the Markdown and HTML outputs.");
  }
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\.\./g, "_");
}

function replaceExtension(filePath: string, extension: string): string {
  return `${stripExtension(filePath)}${extension}`;
}

function stripExtension(filePath: string): string {
  const ext = path.extname(filePath);
  return ext ? filePath.slice(0, -ext.length) : filePath;
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function escapeMarkdownTable(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\r?\n/g, " ");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readProp(target: unknown, key: string): unknown {
  if (target && typeof target === "object" && key in target) {
    return (target as Record<string, unknown>)[key];
  }
  return undefined;
}

function formatMaybeDate(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  return "";
}

function trimForPdf(value: string): string {
  return value.length > MAX_PDF_BODY_PREVIEW ? `${value.slice(0, MAX_PDF_BODY_PREVIEW)}...` : value;
}

function inferRemoteFilename(
  url: string,
  disposition: string | null,
  contentType?: string,
  fallback = "downloaded-file"
): string {
  const filenameFromHeader = disposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/)?.[1];
  if (filenameFromHeader) {
    return decodeURIComponent(filenameFromHeader);
  }

  try {
    const parsed = new URL(url);
    const leaf = parsed.pathname.split("/").filter(Boolean).pop();
    if (leaf && leaf !== "view" && leaf !== "uc") {
      return ensureFileExtension(leaf, contentType);
    }
  } catch {
    // Keep fallback below.
  }

  return ensureFileExtension(fallback, contentType);
}

function ensureFileExtension(name: string, contentType?: string): string {
  return path.extname(name) ? name : `${name}${guessExtensionFromType(contentType)}`;
}

function guessExtensionFromType(contentType?: string | null): string {
  if (!contentType) {
    return "";
  }
  if (contentType.includes("pdf")) return ".pdf";
  if (contentType.includes("html")) return ".html";
  if (contentType.includes("json")) return ".json";
  if (contentType.includes("csv")) return ".csv";
  if (contentType.includes("spreadsheet")) return ".xlsx";
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("jpeg")) return ".jpg";
  if (contentType.includes("plain")) return ".txt";
  return "";
}

function isGoogleDriveFolderUrl(url: string): boolean {
  return /drive\.google\.com\/drive\/folders\//.test(url);
}

function isGoogleDriveFileUrl(url: string): boolean {
  return /drive\.google\.com\/file\/d\//.test(url) || /drive\.google\.com\/uc\?/.test(url) || /open\?id=/.test(url);
}

function extractGoogleDriveFolderId(url: string): string | null {
  return url.match(/\/folders\/([^/?#]+)/)?.[1] ?? null;
}

function extractGoogleDriveFileId(url: string): string | null {
  return url.match(/\/file\/d\/([^/?#]+)/)?.[1] ?? url.match(/[?&]id=([^&#]+)/)?.[1] ?? null;
}

function absolutizeDriveUrl(url: string): string {
  if (url.startsWith("http")) {
    return url;
  }
  return new URL(url, "https://drive.google.com").toString();
}

function formatBytes(value: number): string {
  if (!value) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
}
