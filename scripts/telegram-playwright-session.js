const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { pathToFileURL } = require("url");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const SESSION_DIR = path.join(ROOT, "storage", "telegram", "playwright-session");
const PROFILE_DIR = path.join(SESSION_DIR, "profile");
const ARTIFACT_DIR = path.join(SESSION_DIR, "artifacts");
const STATE_FILE = path.join(SESSION_DIR, "state.json");
let contextPromise = null;

function timestampLabel() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function truncateText(value, limit = 3500) {
  const text = String(value || "").trim();
  return text.length > limit ? `${text.slice(0, limit - 16)}\n\n[truncated]` : text;
}

function normalizeTarget(target) {
  const value = String(target || "").trim();
  if (!value) {
    throw new Error("A Playwright target is required.");
  }
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  if (path.isAbsolute(value) && fs.existsSync(value)) {
    return pathToFileURL(value).href;
  }
  throw new Error("Playwright open currently supports http(s) URLs or existing absolute file paths.");
}

function isBlankBrowserPage(page) {
  const url = String(page && page.url ? page.url() : "").trim();
  return !url || /^(about:blank|chrome:\/\/newtab\/?)$/i.test(url);
}

async function ensureDirs() {
  await fsp.mkdir(PROFILE_DIR, { recursive: true });
  await fsp.mkdir(ARTIFACT_DIR, { recursive: true });
}

async function readState() {
  try {
    return JSON.parse(await fsp.readFile(STATE_FILE, "utf8"));
  } catch {
    return { currentTab: 0 };
  }
}

async function writeState(state) {
  await ensureDirs();
  await fsp.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

async function getContext() {
  await ensureDirs();
  if (!contextPromise) {
    contextPromise = chromium.launchPersistentContext(PROFILE_DIR, {
      headless: true,
      viewport: { width: 1440, height: 960 }
    }).then((context) => {
      context.on("close", () => {
        contextPromise = null;
      });
      return context;
    }).catch((error) => {
      contextPromise = null;
      throw error;
    });
  }
  return contextPromise;
}

async function withContext(task) {
  const context = await getContext();
  return task(context);
}

async function resolveCurrentPage(context, options = {}) {
  const { createIfMissing = false } = options;
  const state = await readState();
  const pages = context.pages().filter((page) => !isBlankBrowserPage(page));
  if (!pages.length && !createIfMissing) {
    throw new Error("There are no Playwright tabs yet. Use /pwopen first.");
  }
  const pageList = pages.length ? pages : [await context.newPage()];
  const index = Math.max(0, Math.min(Number(state.currentTab || 0), pageList.length - 1));
  await writeState({ currentTab: index });
  return {
    page: pageList[index],
    pages: pageList,
    index
  };
}

async function openPlaywrightTarget(target) {
  return withContext(async (context) => {
    const existingPages = context.pages();
    const reusable = existingPages.find((page) => isBlankBrowserPage(page));
    const page = reusable || await context.newPage();
    await page.goto(normalizeTarget(target), { waitUntil: "domcontentloaded", timeout: 30000 });
    const pages = context.pages();
    const index = pages.findIndex((entry) => entry === page);
    await writeState({ currentTab: index >= 0 ? index : pages.length - 1 });
    return {
      url: page.url(),
      title: await page.title().catch(() => ""),
      tabCount: pages.length
    };
  });
}

async function listPlaywrightTabs() {
  return withContext(async (context) => {
    const pages = context.pages().filter((page) => !isBlankBrowserPage(page));
    if (!pages.length) {
      return [];
    }
    const state = await readState();
    const index = Math.max(0, Math.min(Number(state.currentTab || 0), pages.length - 1));
    const tabs = [];
    for (const [tabIndex, page] of pages.entries()) {
      tabs.push({
        index: tabIndex,
        active: tabIndex === index,
        title: await page.title().catch(() => ""),
        url: page.url()
      });
    }
    return tabs;
  });
}

async function selectPlaywrightTab(index) {
  return withContext(async (context) => {
    const pages = context.pages();
    if (!pages.length) {
      throw new Error("There are no Playwright tabs yet. Use /pwopen first.");
    }
    const next = Number(index);
    if (!Number.isInteger(next) || next < 0 || next >= pages.length) {
      throw new Error(`Tab index ${index} is out of range.`);
    }
    await writeState({ currentTab: next });
    const page = pages[next];
    return {
      index: next,
      title: await page.title().catch(() => ""),
      url: page.url()
    };
  });
}

function locatorCandidates(page, target) {
  const value = String(target || "").trim();
  if (!value) {
    throw new Error("A selector or visible label is required.");
  }
  if (/^(css|xpath|text)=/i.test(value)) {
    return [page.locator(value)];
  }
  if (/[#.[>:]/.test(value)) {
    return [page.locator(value)];
  }
  return [
    page.getByRole("button", { name: value }),
    page.getByRole("link", { name: value }),
    page.getByLabel(value),
    page.getByPlaceholder(value),
    page.getByText(value, { exact: false }),
    page.locator(value)
  ];
}

async function resolveLocator(page, target) {
  const attempts = locatorCandidates(page, target);
  for (const locator of attempts) {
    try {
      if (await locator.first().count()) {
        return locator.first();
      }
    } catch {}
  }
  throw new Error(`Could not find an element matching "${target}".`);
}

async function snapshotPlaywrightPage() {
  return withContext(async (context) => {
    const { page } = await resolveCurrentPage(context);
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    const interactive = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a,button,input,textarea,select,[role='button']"))
        .slice(0, 20)
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          text: (element.innerText || element.textContent || element.getAttribute("aria-label") || element.getAttribute("placeholder") || "").trim().slice(0, 120),
          id: element.id || "",
          name: element.getAttribute("name") || "",
          type: element.getAttribute("type") || ""
        }))
    );
    return {
      title: await page.title().catch(() => ""),
      url: page.url(),
      bodyText: truncateText(await page.locator("body").innerText().catch(() => "")),
      interactive
    };
  });
}

async function screenshotPlaywrightPage() {
  return withContext(async (context) => {
    const { page } = await resolveCurrentPage(context);
    const target = path.join(ARTIFACT_DIR, `${timestampLabel()}-page.png`);
    await page.screenshot({ path: target, fullPage: true });
    return target;
  });
}

async function clickPlaywrightTarget(target) {
  return withContext(async (context) => {
    const { page } = await resolveCurrentPage(context);
    const locator = await resolveLocator(page, target);
    await locator.click({ timeout: 15000 });
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    return {
      title: await page.title().catch(() => ""),
      url: page.url()
    };
  });
}

async function typeIntoPlaywrightTarget(target, value) {
  return withContext(async (context) => {
    const { page } = await resolveCurrentPage(context);
    const locator = await resolveLocator(page, target);
    await locator.fill(String(value || ""), { timeout: 15000 });
    return {
      title: await page.title().catch(() => ""),
      url: page.url()
    };
  });
}

async function pressPlaywrightKey(key) {
  return withContext(async (context) => {
    const { page } = await resolveCurrentPage(context);
    await page.keyboard.press(String(key || "").trim() || "Enter");
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    return {
      title: await page.title().catch(() => ""),
      url: page.url()
    };
  });
}

async function closePlaywrightSession() {
  await fsp.rm(STATE_FILE, { force: true }).catch(() => {});
  const context = await contextPromise;
  if (!context) {
    return true;
  }
  contextPromise = null;
  await context.close().catch(() => {});
  return true;
}

module.exports = {
  closePlaywrightSession,
  clickPlaywrightTarget,
  listPlaywrightTabs,
  openPlaywrightTarget,
  pressPlaywrightKey,
  screenshotPlaywrightPage,
  selectPlaywrightTab,
  snapshotPlaywrightPage,
  typeIntoPlaywrightTarget
};
