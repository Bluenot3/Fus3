const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { pathToFileURL } = require("url");
const { chromium } = require("playwright");

const DIRECTORY_ENTRY_LIMIT = 200;
const TEXT_PREVIEW_LIMIT = 12000;
const BODY_TEXT_LIMIT = 3500;
const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".js",
  ".cjs",
  ".mjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".css",
  ".scss",
  ".html",
  ".htm",
  ".xml",
  ".yml",
  ".yaml",
  ".csv",
  ".tsv",
  ".log",
  ".ps1",
  ".cmd",
  ".bat",
  ".py"
]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
const EMBED_EXTENSIONS = new Set([".pdf"]);

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function slugify(value) {
  const compact = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return compact || "item";
}

function timestampLabel() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function formatBytes(size) {
  if (!size) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(size);
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function truncateText(value, limit) {
  const text = String(value || "").trim();
  return text.length > limit ? `${text.slice(0, limit - 16)}\n\n[truncated]` : text;
}

function isProbablyUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

async function readTextPreview(filePath) {
  const handle = await fsp.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(TEXT_PREVIEW_LIMIT);
    const { bytesRead } = await handle.read(buffer, 0, TEXT_PREVIEW_LIMIT, 0);
    return truncateText(buffer.subarray(0, bytesRead).toString("utf8"), TEXT_PREVIEW_LIMIT);
  } finally {
    await handle.close();
  }
}

async function buildDirectoryView(dirPath, htmlPath) {
  const dirents = await fsp.readdir(dirPath, { withFileTypes: true });
  const entries = [];
  for (const dirent of dirents.slice(0, DIRECTORY_ENTRY_LIMIT)) {
    const fullPath = path.join(dirPath, dirent.name);
    let stats = null;
    try {
      stats = await fsp.stat(fullPath);
    } catch {}
    entries.push({
      name: dirent.name,
      fullPath,
      kind: dirent.isDirectory() ? "directory" : "file",
      size: stats && !dirent.isDirectory() ? stats.size : 0,
      modifiedAt: stats ? stats.mtime.toISOString() : ""
    });
  }

  const body = [
    "<!doctype html>",
    "<html><head><meta charset=\"utf-8\">",
    `<title>${escapeHtml(`Desktop Navigator - ${dirPath}`)}</title>`,
    "<style>",
    "body{font-family:Segoe UI,Arial,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:32px;line-height:1.45;}",
    "h1{margin:0 0 8px;font-size:28px;} p.meta{color:#94a3b8;margin:0 0 24px;}",
    ".grid{display:grid;grid-template-columns:1.4fr .7fr .8fr 1fr;gap:12px;align-items:start;}",
    ".row{padding:10px 12px;border-radius:14px;background:rgba(30,41,59,.76);margin-bottom:10px;}",
    ".name{font-weight:600;word-break:break-word;} .kind{color:#7dd3fc;text-transform:uppercase;font-size:12px;letter-spacing:.08em;}",
    ".path{color:#cbd5e1;font-size:13px;word-break:break-all;grid-column:1 / -1;} .empty{color:#94a3b8;}",
    "</style></head><body>",
    `<h1>${escapeHtml(path.basename(dirPath) || dirPath)}</h1>`,
    `<p class="meta">Directory view rendered for Playwright. Source: ${escapeHtml(dirPath)}</p>`,
    entries.length ? "<div>" : "<p class=\"empty\">This directory is empty.</p>",
    ...entries.map((entry) => [
      "<div class=\"row\">",
      "<div class=\"grid\">",
      `<div class="name">${escapeHtml(entry.name)}</div>`,
      `<div class="kind">${escapeHtml(entry.kind)}</div>`,
      `<div>${escapeHtml(entry.kind === "directory" ? "-" : formatBytes(entry.size))}</div>`,
      `<div>${escapeHtml(entry.modifiedAt || "-")}</div>`,
      `<div class="path">${escapeHtml(entry.fullPath)}</div>`,
      "</div>",
      "</div>"
    ].join("")),
    entries.length ? "</div>" : "",
    "</body></html>"
  ].join("");

  await fsp.writeFile(htmlPath, body, "utf8");
  return {
    kind: "directory",
    sourcePath: dirPath,
    renderedPath: htmlPath,
    pageUrl: pathToFileURL(htmlPath).href,
    entries
  };
}

async function buildFileView(filePath, htmlPath) {
  const stats = await fsp.stat(filePath);
  const extension = path.extname(filePath).toLowerCase();
  const sourceUrl = pathToFileURL(filePath).href;
  let contentHtml = `<p>Size: ${escapeHtml(formatBytes(stats.size))}</p>`;
  let previewText = "";

  if (TEXT_EXTENSIONS.has(extension) || stats.size <= 64 * 1024) {
    previewText = await readTextPreview(filePath);
    contentHtml = `<pre>${escapeHtml(previewText)}</pre>`;
  } else if (IMAGE_EXTENSIONS.has(extension)) {
    contentHtml = `<img src="${escapeHtml(sourceUrl)}" alt="${escapeHtml(path.basename(filePath))}" style="max-width:100%;height:auto;border-radius:18px;">`;
  } else if (EMBED_EXTENSIONS.has(extension)) {
    contentHtml = `<iframe src="${escapeHtml(sourceUrl)}" title="${escapeHtml(path.basename(filePath))}" style="width:100%;height:85vh;border:none;border-radius:18px;background:#fff;"></iframe>`;
  } else {
    contentHtml = [
      "<p>This file type is not previewed inline.</p>",
      `<p>Extension: ${escapeHtml(extension || "(none)")}</p>`,
      `<p>Size: ${escapeHtml(formatBytes(stats.size))}</p>`
    ].join("");
  }

  const body = [
    "<!doctype html>",
    "<html><head><meta charset=\"utf-8\">",
    `<title>${escapeHtml(`Desktop Preview - ${filePath}`)}</title>`,
    "<style>",
    "body{font-family:Segoe UI,Arial,sans-serif;background:#111827;color:#f8fafc;margin:0;padding:28px;line-height:1.5;}",
    "h1{margin:0 0 10px;font-size:26px;} .meta{color:#94a3b8;margin-bottom:20px;word-break:break-all;}",
    "pre{white-space:pre-wrap;word-break:break-word;background:#0f172a;padding:20px;border-radius:18px;border:1px solid rgba(148,163,184,.25);}",
    "</style></head><body>",
    `<h1>${escapeHtml(path.basename(filePath))}</h1>`,
    `<div class="meta">${escapeHtml(filePath)}</div>`,
    contentHtml,
    "</body></html>"
  ].join("");

  await fsp.writeFile(htmlPath, body, "utf8");
  return {
    kind: "file",
    sourcePath: filePath,
    renderedPath: htmlPath,
    pageUrl: pathToFileURL(htmlPath).href,
    previewText
  };
}

async function prepareTarget(target, outputDir) {
  if (isProbablyUrl(target)) {
    return {
      kind: "url",
      sourcePath: String(target),
      renderedPath: "",
      pageUrl: String(target)
    };
  }

  const resolvedPath = path.resolve(String(target || ""));
  const stats = await fsp.stat(resolvedPath);
  const htmlPath = path.join(outputDir, `${timestampLabel()}-${slugify(path.basename(resolvedPath) || "desktop")}.html`);
  if (stats.isDirectory()) {
    return buildDirectoryView(resolvedPath, htmlPath);
  }
  return buildFileView(resolvedPath, htmlPath);
}

async function navigateDesktopTarget({ target, outputDir, headless = true }) {
  if (!target) {
    throw new Error("A desktop navigation target is required.");
  }

  await fsp.mkdir(outputDir, { recursive: true });
  const prepared = await prepareTarget(target, outputDir);
  const screenshotPath = path.join(
    outputDir,
    `${timestampLabel()}-${slugify(path.basename(prepared.sourcePath) || prepared.kind)}.png`
  );

  const browser = await chromium.launch({ headless });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    await page.goto(prepared.pageUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(250);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const title = await page.title().catch(() => "");
    const bodyText = truncateText(
      await page.locator("body").innerText().catch(() => ""),
      BODY_TEXT_LIMIT
    );

    return {
      ...prepared,
      title,
      bodyText,
      screenshotPath
    };
  } finally {
    await browser.close();
  }
}

module.exports = {
  navigateDesktopTarget
};
