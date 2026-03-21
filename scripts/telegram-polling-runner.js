const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { exec } = require("child_process");
const PDFDocument = require("pdfkit");
const XLSX = require("xlsx");
const mammoth = require("mammoth");
const pdfParse = require("pdf-parse");
const {
  notionSearch,
  notionRetrievePage,
  notionRetrieveBlockChildren,
  notionAppendToPage,
  notionCreatePage,
  notionQueryDataSource,
  notionListUsers,
  manusCreateTask,
  manusCreateConnectedTask,
  manusGetTask,
  manusListTasks
} = require("./telegram-external-clients");
const {
  currentSelection,
  describeProfiles,
  findProfile,
  generateText,
  listModels: listProviderModels,
  pickCheapestUsefulModel
} = require("./telegram-ai-providers");

const ROOT = process.cwd();
const STORAGE_DIR = path.join(ROOT, "storage", "telegram");
const BOTS_FILE = path.join(STORAGE_DIR, "bots.json");
const LOG_DIR = path.join(STORAGE_DIR, "logs");
const CHAT_DIR = path.join(STORAGE_DIR, "chats");
const SCHEDULES_FILE = path.join(STORAGE_DIR, "schedules.json");
const DEVICES_FILE = path.join(STORAGE_DIR, "devices.json");
const AGENT_TASKS_FILE = path.join(STORAGE_DIR, "agent-tasks.json");
const ACTIVE_AGENT_TASKS = new Set();
const DEFAULT_TIMEOUT_MS = 20000;
const TELEGRAM_LIMIT = 3900;
const MAX_HISTORY_MESSAGES = 10;
const MAX_TOOL_ACTIONS = 3;
const SEARCH_RESULT_LIMIT = 25;
const POLL_BACKOFF_MS = 8000;
const SCHEDULER_TICK_MS = 15000;
const TASK_SOURCE_MAX_CHARS = 28000;
const UPDATE_DEDUPE_TTL_MS = 10 * 60 * 1000;
const REPLY_DEDUPE_TTL_MS = 20 * 1000;
const DANGEROUS_COMMAND_PATTERNS = [
  /\bremove-item\b/i,
  /\bdel\b/i,
  /\berase\b/i,
  /\brd\b/i,
  /\brmdir\b/i,
  /\bformat\b/i,
  /\bshutdown\b/i,
  /\brestart-computer\b/i,
  /\bstop-computer\b/i,
  /\bset-net(ip|route|firewall)\b/i,
  /\bnew-netfirewallrule\b/i,
  /\bdisable-netadapter\b/i,
  /\benable-netadapter\b/i,
  /\btaskkill\b/i,
  /\bstop-process\b/i,
  /\bsc\s+stop\b/i,
  /\breg\s+delete\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\b/i
];
const RECENT_UPDATE_KEYS = new Map();
const RECENT_REPLY_KEYS = new Map();

loadEnvFile(path.join(ROOT, ".env.local"));

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.trim().startsWith("#")) {
      continue;
    }
    const index = line.indexOf("=");
    if (index < 0) {
      continue;
    }
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function requireEncryptionKey() {
  const raw = process.env.SECRET_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("SECRET_ENCRYPTION_KEY is required.");
  }
  return crypto.createHash("sha256").update(raw).digest();
}

function decryptSecret(payload) {
  const [ivB64, tagB64, dataB64] = String(payload || "").split(".");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Encrypted secret payload is malformed.");
  }

  const decipher = crypto.createDecipheriv("aes-256-gcm", requireEncryptionKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
  return decrypted.toString("utf8");
}

async function telegram(token, method, body) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    const error = new Error(payload.description || `Telegram ${method} failed`);
    error.errorCode = payload.error_code || response.status;
    error.retryAfter = Number(payload.parameters?.retry_after || 0);
    throw error;
  }
  return payload.result;
}

function touchRecentKey(cache, key, ttlMs) {
  const now = Date.now();
  const previous = cache.get(key);
  for (const [entryKey, timestamp] of cache.entries()) {
    if (now - timestamp > ttlMs) {
      cache.delete(entryKey);
    }
  }
  cache.set(key, now);
  return previous && now - previous < ttlMs;
}

function duplicateReplyKey(chatId, text) {
  return `${chatId}:${String(text || "").trim().slice(0, 1200)}`;
}

function isRateLimitError(error) {
  const message = String(error && (error.message || error) || "");
  return Number(error && error.errorCode) === 429 || /too many requests|retry after/i.test(message);
}

function retryAfterMs(error, fallbackMs = 3000) {
  const seconds = Number(error && error.retryAfter || 0);
  return seconds > 0 ? seconds * 1000 : fallbackMs;
}

async function sendTelegramText(token, chatId, text, extra = {}) {
  const normalized = truncateForTelegram(text);
  if (touchRecentKey(RECENT_REPLY_KEYS, duplicateReplyKey(chatId, normalized), REPLY_DEDUPE_TTL_MS)) {
    return { ok: true, suppressed: true };
  }
  return telegram(token, "sendMessage", {
    chat_id: chatId,
    text: normalized,
    ...extra
  });
}

async function sendTelegramDocument(token, chatId, filePath, caption = "") {
  const form = new FormData();
  const buffer = await fsp.readFile(filePath);
  form.append("chat_id", String(chatId));
  if (caption) {
    form.append("caption", truncateForTelegram(caption));
  }
  form.append("document", new Blob([buffer]), path.basename(filePath));

  const response = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: "POST",
    body: form
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) {
    throw new Error(payload.description || `Telegram sendDocument failed for ${path.basename(filePath)}`);
  }
  return payload.result;
}

function startTypingLoop(token, chatId) {
  let stopped = false;
  let timer = null;

  const ping = () => telegram(token, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
  ping();
  timer = setInterval(ping, 4000);

  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(timer);
  };
}

function commandKeyboard() {
  return {
    keyboard: [
      [{ text: "/menu" }, { text: "/status" }, { text: "/capabilities" }],
      [{ text: "/docs" }, { text: "/newdoc" }, { text: "/workon" }],
      [{ text: "/autopilot" }, { text: "/squad" }, { text: "/tasks" }],
      [{ text: "/providers" }, { text: "/models" }, { text: "/clear" }]
    ],
    resize_keyboard: true,
    is_persistent: true
  };
}

function inlineKeyboard(rows) {
  return {
    inline_keyboard: rows.map((row) =>
      row.map((button) => ({
        text: button.text,
        callback_data: button.data
      }))
    )
  };
}

function homeInlineKeyboard() {
  return inlineKeyboard([
    [{ text: "Status", data: "cmd:status" }, { text: "Health", data: "cmd:health" }],
    [{ text: "Files", data: "cmd:files" }, { text: "Project", data: "cmd:project" }],
    [{ text: "Wix", data: "cmd:wix" }, { text: "Notion", data: "cmd:notionstatus" }],
    [{ text: "Workbench", data: "cmd:workbench" }, { text: "Manus", data: "cmd:manuslist" }],
    [{ text: "Network", data: "cmd:network" }, { text: "Mode Build", data: "cmd:mode build" }],
    [{ text: "Providers", data: "nav:ai" }, { text: "Tasks", data: "nav:tasks" }],
    [{ text: "Schedules", data: "cmd:schedules" }, { text: "Models", data: "cmd:models" }],
    [{ text: "Clear Chat", data: "cmd:clear" }]
  ]);
}

function wixInlineKeyboard() {
  return inlineKeyboard([
    [{ text: "Site Summary", data: "cmd:wix" }, { text: "Recent Contacts", data: "cmd:wixcontacts" }],
    [{ text: "Status", data: "cmd:status" }, { text: "Home", data: "nav:home" }]
  ]);
}

function projectInlineKeyboard() {
  return inlineKeyboard([
    [{ text: "Files", data: "cmd:files" }, { text: "Git Status", data: "cmd:gitstatus" }],
    [{ text: "Git Log", data: "cmd:gitlog" }, { text: "Find package", data: "cmd:find package" }],
    [{ text: "Tree", data: "cmd:tree" }, { text: "Workbench", data: "nav:build" }],
    [{ text: "Home", data: "nav:home" }]
  ]);
}

function networkInlineKeyboard() {
  return inlineKeyboard([
    [{ text: "Network", data: "cmd:network" }, { text: "Wi-Fi", data: "cmd:wifi" }],
    [{ text: "Ping Gateway", data: "cmd:ping 192.168.1.1" }, { text: "Ports Gateway", data: "cmd:ports 192.168.1.1" }],
    [{ text: "Home", data: "nav:home" }]
  ]);
}

function scheduleInlineKeyboard() {
  return inlineKeyboard([
    [{ text: "List Schedules", data: "cmd:schedules" }, { text: "Schedule Help", data: "cmd:schedulehelp" }],
    [{ text: "Health Every 30m", data: "cmd:scheduleadd every 30m | /health" }],
    [{ text: "Project Daily 09:00", data: "cmd:scheduleadd daily 09:00 | /project" }],
    [{ text: "Home", data: "nav:home" }]
  ]);
}

function notionInlineKeyboard() {
  return inlineKeyboard([
    [{ text: "Notion Status", data: "cmd:notionstatus" }, { text: "Search Notes", data: "cmd:notionsearch standup" }],
    [{ text: "Open BGCGW", data: "cmd:notionopen BGCGW" }, { text: "Append to BGCGW", data: "cmd:notionappendto BGCGW | Quick update from Telegram" }],
    [{ text: "List Users", data: "cmd:notionusers" }, { text: "Home", data: "nav:home" }]
  ]);
}

function manusInlineKeyboard() {
  return inlineKeyboard([
    [{ text: "List Tasks", data: "cmd:manuslist" }, { text: "Low-Cost Task", data: "cmd:manus summarize repo changes" }],
    [{ text: "Notion Task", data: "cmd:manusnotion summarize my accessible Notion notes" }],
    [{ text: "Home", data: "nav:home" }]
  ]);
}

function aiInlineKeyboard() {
  return inlineKeyboard([
    [{ text: "Providers", data: "cmd:providers" }, { text: "Models", data: "cmd:models" }],
    [{ text: "Use Ollama", data: "cmd:provider ollama" }, { text: "Use Cohere", data: "cmd:provider cohere" }],
    [{ text: "Use Claude", data: "cmd:provider anthropic" }, { text: "Use OpenRouter", data: "cmd:provider openrouter" }],
    [{ text: "Use OpenAI 1", data: "cmd:provider openai:project1" }, { text: "Reset Qwen", data: "cmd:modeluse ollama | qwen2.5-coder:7b" }],
    [{ text: "Tasks", data: "nav:tasks" }, { text: "Home", data: "nav:dashboard" }]
  ]);
}

function tasksInlineKeyboard() {
  return inlineKeyboard([
    [{ text: "Task List", data: "cmd:tasks" }, { text: "Task Help", data: "cmd:agenthelp" }],
    [{ text: "Doc Agent", data: "cmd:docagent desktop\\ZEN Intake\\sample.txt | build a detailed working plan" }],
    [{ text: "Claude Doc", data: "cmd:delegate anthropic | doc | desktop\\ZEN Intake\\sample.txt | build a nuanced structured brief" }],
    [{ text: "Autopilot", data: "cmd:autopilot doc | desktop\\ZEN Intake\\sample.txt | choose the best agent and build the pack" }],
    [{ text: "Squad", data: "cmd:squad doc | desktop\\ZEN Intake\\sample.txt | run a multi-agent comparison and synthesis" }],
    [{ text: "Sheet Agent", data: "cmd:sheetagent desktop\\sample.xlsx | summarize this sheet and produce actions" }],
    [{ text: "Site Agent", data: "cmd:siteagent wix | audit the site and suggest upgrades" }],
    [{ text: "Home", data: "nav:dashboard" }]
  ]);
}

function defaultInlineKeyboard() {
  return homeInlineKeyboard();
}

function navigationScreen(bot, key) {
  if (key === "dashboard") {
    return { text: dashboardText(bot), extra: { reply_markup: dashboardInlineKeyboard() } };
  }
  if (key === "control") {
    return { text: "Control panel", extra: { reply_markup: controlInlineKeyboard() } };
  }
  if (key === "network") {
    return { text: "Network panel", extra: { reply_markup: networkInlineKeyboard() } };
  }
  if (key === "devices") {
    return { text: "Devices panel", extra: { reply_markup: devicesInlineKeyboard() } };
  }
  if (key === "integrations") {
    return { text: "Integrations panel", extra: { reply_markup: integrationsInlineKeyboard() } };
  }
  if (key === "files") {
    return { text: "Files panel", extra: { reply_markup: projectInlineKeyboard() } };
  }
  if (key === "ai") {
    return { text: "AI providers panel", extra: { reply_markup: aiInlineKeyboard() } };
  }
  if (key === "build") {
    return { text: "Build panel", extra: { reply_markup: buildInlineKeyboard() } };
  }
  if (key === "tasks") {
    return { text: "Agent tasks panel", extra: { reply_markup: tasksInlineKeyboard() } };
  }
  if (key === "schedules") {
    return { text: "Schedules panel", extra: { reply_markup: scheduleInlineKeyboard() } };
  }
  return { text: dashboardText(bot), extra: { reply_markup: dashboardInlineKeyboard() } };
}

function dashboardText(bot) {
  return [
    `${bot.name} control center`,
    "",
    `Default supervisor: local qwen2.5-coder (${bot.ollamaModel || "qwen2.5-coder:7b"})`,
    "Quickest phone flows:",
    "- /newdoc to create a document",
    "- /workon to hand a document to the agent",
    "- /autopilot to let the bot choose the best provider",
    "- /squad to run a multi-model synthesis",
    "",
    "Use the panels below for documents, AI control, integrations, and scheduled work."
  ].join("\n");
}

function dashboardInlineKeyboard() {
  return inlineKeyboard([
    [{ text: "Control", data: "nav:control" }, { text: "Network", data: "nav:network" }],
    [{ text: "Devices", data: "nav:devices" }, { text: "Integrations", data: "nav:integrations" }],
    [{ text: "Files", data: "nav:files" }, { text: "Build", data: "nav:build" }],
    [{ text: "AI", data: "nav:ai" }, { text: "Tasks", data: "nav:tasks" }],
    [{ text: "Schedules", data: "nav:schedules" }]
  ]);
}

function controlInlineKeyboard() {
  return inlineKeyboard([
    [{ text: "Status", data: "cmd:status" }, { text: "Health", data: "cmd:health" }],
    [{ text: "Project", data: "cmd:project" }, { text: "Workbench", data: "cmd:workbench" }],
    [{ text: "Models", data: "cmd:models" }, { text: "Providers", data: "cmd:providers" }],
    [{ text: "Build Mode", data: "cmd:mode build" }, { text: "Tasks", data: "cmd:tasks" }],
    [{ text: "Home", data: "nav:dashboard" }]
  ]);
}

function integrationsInlineKeyboard() {
  return inlineKeyboard([
    [{ text: "Wix", data: "cmd:wix" }, { text: "Notion", data: "cmd:notionstatus" }],
    [{ text: "Manus", data: "cmd:manuslist" }, { text: "Users", data: "cmd:notionusers" }],
    [{ text: "Providers", data: "nav:ai" }, { text: "Tasks", data: "nav:tasks" }],
    [{ text: "Home", data: "nav:dashboard" }]
  ]);
}

function devicesInlineKeyboard() {
  return inlineKeyboard([
    [{ text: "Known Devices", data: "cmd:devices" }, { text: "Scan LAN", data: "cmd:devicescan" }],
    [{ text: "Wi-Fi", data: "cmd:wifi" }, { text: "Network", data: "cmd:network" }],
    [{ text: "Home", data: "nav:dashboard" }]
  ]);
}

function buildInlineKeyboard() {
  return inlineKeyboard([
    [{ text: "Workbench", data: "cmd:workbench" }, { text: "Mode Build", data: "cmd:mode build" }],
    [{ text: "Ideas", data: "cmd:ideas app ideas for my repo" }, { text: "Plan", data: "cmd:planbuild build a new polished dashboard" }],
    [{ text: "Outline", data: "cmd:outline build a launch-ready execution outline" }, { text: "Draft", data: "cmd:draft telegram-draft | first draft created from Telegram" }],
    [{ text: "HTML", data: "cmd:html scratch\\prototype.html | build a polished landing page" }, { text: "Spec", data: "cmd:spec docs\\idea.md | outline a project spec" }],
    [{ text: "Start Intake", data: "cmd:intake dispute-case | create a detailed factual plan and draft emails" }, { text: "Case Pack", data: "cmd:casepack desktop\\ZEN Intake\\sample.txt | build a full case room" }],
    [{ text: "New Doc", data: "cmd:newdoc idea-note | created from Telegram" }, { text: "Docs", data: "cmd:docs" }],
    [{ text: "Summarize", data: "cmd:summarize desktop\\ZEN Intake\\sample.txt | summarize the main points and next actions" }, { text: "Work On Doc", data: "cmd:workon desktop\\ZEN Docs\\sample.md | improve this and make it actionable" }],
    [{ text: "Doc Agent", data: "cmd:docagent desktop\\ZEN Intake\\sample.txt | build a detailed execution pack" }, { text: "Sheet Agent", data: "cmd:sheetagent desktop\\sample.xlsx | turn this sheet into an action plan" }],
    [{ text: "Site Agent", data: "cmd:siteagent wix | audit the site and suggest stronger next steps" }, { text: "Tasks", data: "nav:tasks" }],
    [{ text: "Autopilot", data: "cmd:autopilot general | desktop\\ZEN Intake\\sample.txt | choose the best provider and build it" }, { text: "Squad", data: "cmd:squad general | desktop\\ZEN Intake\\sample.txt | run a multi-model synthesis" }],
    [{ text: "Desktop Files", data: "cmd:files desktop" }],
    [{ text: "Read Mode", data: "cmd:mode read" }, { text: "Home", data: "nav:dashboard" }]
  ]);
}

function replyMarkupForCommand(command, forceInline = false) {
  const inline =
    command === "menu" || command === "dashboard"
      ? dashboardInlineKeyboard()
      : command === "workbench" || command === "mode" || command === "ideas" || command === "planbuild" || command === "html" || command === "component" || command === "route" || command === "spec" || command === "replace" || command === "zip" || command === "docagent" || command === "sheetagent" || command === "siteagent" || command === "agenttask" || command === "supervisor" || command === "delegate" || command === "autopilot" || command === "squad" || command === "capabilities" || command === "newdoc" || command === "workon"
        ? buildInlineKeyboard()
      : command === "providers" || command === "provider" || command === "models" || command === "model" || command === "modeluse"
        ? aiInlineKeyboard()
      : command === "wix" || command === "wixcontacts"
      ? wixInlineKeyboard()
      : command === "notionstatus" || command === "notionsearch" || command === "notionopen" || command === "notionpage" || command === "notionappend" || command === "notionappendto" || command === "notioncreate" || command === "notioncreatein" || command === "notionquery" || command === "notionusers"
        ? notionInlineKeyboard()
      : command === "manus" || command === "manusstatus" || command === "manuslist"
        ? manusInlineKeyboard()
      : command === "devices" || command === "devicescan" || command === "deviceadd" || command === "deviceping" || command === "deviceports" || command === "devicedetail"
        ? devicesInlineKeyboard()
      : command === "tasks" || command === "taskstatus" || command === "tasksend" || command === "taskcancel" || command === "agenthelp" || command === "autopilot" || command === "squad"
        ? tasksInlineKeyboard()
      : command === "schedules" || command === "scheduleadd" || command === "scheduledelete" || command === "schedulehelp"
        ? scheduleInlineKeyboard()
      : command === "network" || command === "wifi" || command === "ping" || command === "ports"
        ? networkInlineKeyboard()
        : command === "files" || command === "docs" || command === "viewdoc" || command === "find" || command === "grep" || command === "gitstatus" || command === "gitlog" || command === "project"
          ? projectInlineKeyboard()
          : defaultInlineKeyboard();

  if (forceInline) {
    return { reply_markup: inline };
  }

  return { reply_markup: inline };
}

async function readBots() {
  const raw = await fsp.readFile(BOTS_FILE, "utf8");
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed.bots) ? parsed.bots : [];
}

async function readSchedules() {
  try {
    const raw = await fsp.readFile(SCHEDULES_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.schedules) ? parsed.schedules : [];
  } catch {
    return [];
  }
}

async function writeSchedules(schedules) {
  await fsp.mkdir(STORAGE_DIR, { recursive: true });
  await fsp.writeFile(SCHEDULES_FILE, JSON.stringify({ schedules }, null, 2), "utf8");
}

async function readDevices() {
  try {
    const raw = await fsp.readFile(DEVICES_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.devices) ? parsed.devices : [];
  } catch {
    return [];
  }
}

async function writeDevices(devices) {
  await fsp.mkdir(STORAGE_DIR, { recursive: true });
  await fsp.writeFile(DEVICES_FILE, JSON.stringify({ devices }, null, 2), "utf8");
}

async function readAgentTasks() {
  try {
    const raw = await fsp.readFile(AGENT_TASKS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.tasks) ? parsed.tasks : [];
  } catch {
    return [];
  }
}

async function writeAgentTasks(tasks) {
  await fsp.mkdir(STORAGE_DIR, { recursive: true });
  await fsp.writeFile(AGENT_TASKS_FILE, JSON.stringify({ tasks }, null, 2), "utf8");
}

function existingRoots(paths) {
  return [...new Set(paths.filter(Boolean).map((value) => path.resolve(value)).filter((value) => fs.existsSync(value)))];
}

function desktopCandidates() {
  const home = os.homedir();
  return existingRoots([
    process.env.OneDrive ? path.join(process.env.OneDrive, "Desktop") : "",
    process.env.OneDrive ? path.join(process.env.OneDrive, "Documents") : "",
    path.join(home, "Desktop"),
    path.join(home, "Documents")
  ]);
}

function getAllowedRoots(bot) {
  const configured = Array.isArray(bot.knowledgePaths) && bot.knowledgePaths.length ? bot.knowledgePaths : [ROOT];
  return existingRoots([...configured, ...desktopCandidates()]);
}

function resolveBotArg() {
  const index = process.argv.findIndex((item) => item === "--bot");
  return index >= 0 ? process.argv[index + 1] : "";
}

function findBot(bots, botArg) {
  if (!botArg) {
    return bots[0] || null;
  }

  const normalized = botArg.toLowerCase().replace(/^@/, "");
  return (
    bots.find((bot) => bot.id === botArg) ||
    bots.find((bot) => String(bot.telegramId) === botArg) ||
    bots.find((bot) => (bot.username || "").toLowerCase() === normalized) ||
    bots.find((bot) => bot.name.toLowerCase() === normalized) ||
    null
  );
}

function sanitizeForTelegram(value) {
  if (!value) {
    return "";
  }
  return String(value).replace(/\0/g, "").trim();
}

function truncateForTelegram(value) {
  const text = sanitizeForTelegram(value);
  return text.length > TELEGRAM_LIMIT ? `${text.slice(0, TELEGRAM_LIMIT - 20)}\n\n[truncated]` : text;
}

function makeId(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString("hex")}`;
}

function nowIso() {
  return new Date().toISOString();
}

async function appendRunnerLog(botId, message) {
  try {
    await fsp.mkdir(LOG_DIR, { recursive: true });
    await fsp.writeFile(
      path.join(LOG_DIR, `runner-${botId}.log`),
      `${nowIso()} ${message}\n`,
      { flag: "a" }
    );
  } catch {}
}

function splitCommand(text) {
  const trimmed = String(text || "").trim();
  const [head, ...rest] = trimmed.split(/\s+/);
  return {
    command: head.replace(/^\/+/, "").toLowerCase(),
    args: rest.join(" ").trim()
  };
}

function parseScheduleSpec(rawValue) {
  const value = String(rawValue || "").trim();
  const [rawWhen, ...rest] = value.split("|");
  const when = (rawWhen || "").trim();
  const payload = rest.join("|").trim();

  if (!when || !payload) {
    throw new Error("Use /scheduleadd every 30m | /health or /scheduleadd daily 09:00 | summarize project status");
  }

  const everyMatch = when.match(/^every\s+(\d+)\s*([mh])$/i);
  if (everyMatch) {
    const count = Number(everyMatch[1]);
    const unit = everyMatch[2].toLowerCase();
    const intervalMinutes = unit === "h" ? count * 60 : count;
    if (!Number.isFinite(intervalMinutes) || intervalMinutes < 1) {
      throw new Error("Interval must be at least 1 minute.");
    }
    return {
      cadence: "interval",
      intervalMinutes,
      label: `every ${count}${unit}`,
      payload
    };
  }

  const dailyMatch = when.match(/^daily\s+(\d{1,2}):(\d{2})$/i);
  if (dailyMatch) {
    const hour = Number(dailyMatch[1]);
    const minute = Number(dailyMatch[2]);
    if (hour > 23 || minute > 59) {
      throw new Error("Daily time must use 24-hour HH:MM.");
    }
    return {
      cadence: "daily",
      hour,
      minute,
      label: `daily ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
      payload
    };
  }

  throw new Error("Supported schedule formats: every 30m, every 2h, daily 09:00");
}

function computeNextRun(schedule, baseDate = new Date()) {
  const current = new Date(baseDate);
  if (schedule.cadence === "interval") {
    return new Date(current.getTime() + Number(schedule.intervalMinutes || 0) * 60 * 1000).toISOString();
  }

  if (schedule.cadence === "daily") {
    const next = new Date(current);
    next.setSeconds(0, 0);
    next.setHours(Number(schedule.hour || 0), Number(schedule.minute || 0), 0, 0);
    if (next.getTime() <= current.getTime()) {
      next.setDate(next.getDate() + 1);
    }
    return next.toISOString();
  }

  return current.toISOString();
}

function describeSchedule(schedule) {
  const mode = schedule.payload && String(schedule.payload).trim().startsWith("/") ? "command" : "chat";
  return [
    `#${schedule.shortId} ${schedule.label}`,
    `Mode: ${mode}`,
    `Task: ${schedule.payload}`,
    `Next: ${schedule.nextRunAt || "not scheduled"}`,
    `Last: ${schedule.lastRunAt || "never"}`
  ].join("\n");
}

function isWithinAllowedRoots(candidate, roots) {
  const resolved = path.resolve(candidate);
  return roots.some((root) => {
    const resolvedRoot = path.resolve(root);
    return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`);
  });
}

function resolveAllowedPath(rawValue, roots) {
  const value = String(rawValue || "").trim();
  if (!value) {
    throw new Error("Path is required.");
  }
  const desktopRoot = roots.find((root) => root.toLowerCase().endsWith(`${path.sep}desktop`));
  const documentsRoot = roots.find((root) => root.toLowerCase().endsWith(`${path.sep}documents`));
  let candidate;

  if (path.isAbsolute(value)) {
    candidate = path.resolve(value);
  } else if (desktopRoot && /^desktop[\\/]/i.test(value)) {
    candidate = path.resolve(desktopRoot, value.replace(/^desktop[\\/]/i, ""));
  } else if (documentsRoot && /^documents[\\/]/i.test(value)) {
    candidate = path.resolve(documentsRoot, value.replace(/^documents[\\/]/i, ""));
  } else {
    candidate = path.resolve(roots[0], value);
  }

  if (!isWithinAllowedRoots(candidate, roots)) {
    throw new Error("That path is outside the allowed roots for this bot.");
  }
  return candidate;
}

function formatBytes(size) {
  if (!size) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function parseQuickIntent(text) {
  const value = String(text || "").trim();
  const lower = value.toLowerCase();
  if (!value) {
    return null;
  }
  if (/^(hi|hello|hey|yo)\b/.test(lower)) {
    return { command: "menu", args: "" };
  }
  if (/^(help|menu|start)\b/.test(lower)) {
    return { command: "menu", args: "" };
  }
  if (/^(status|health|capabilities)\b/.test(lower)) {
    return { command: lower.split(/\s+/)[0], args: "" };
  }
  if (/^(docs|documents)\b/.test(lower)) {
    return { command: "docs", args: "" };
  }
  if (/^(new\s+doc|new\s+dock|new\s+document|create\s+doc|create\s+document)\b/.test(lower)) {
    const title = value.replace(/^(new\s+doc|new\s+dock|new\s+document|create\s+doc|create\s+document)\b[:\s-]*/i, "").trim();
    return { command: "newdoc", args: title || "quick-note" };
  }
  if (/^(work\s+on|assign\s+doc|assign\s+document)\b/.test(lower)) {
    const rest = value.replace(/^(work\s+on|assign\s+doc|assign\s+document)\b[:\s-]*/i, "").trim();
    if (rest) {
      return { command: "workon", args: rest };
    }
  }
  if (/^(brainstorm|ideas)\b/.test(lower)) {
    const rest = value.replace(/^(brainstorm|ideas)\b[:\s-]*/i, "").trim();
    return { command: "ideas", args: rest || "new high-impact things to build" };
  }
  if (/^(outline|plan)\b/.test(lower)) {
    const rest = value.replace(/^(outline|plan)\b[:\s-]*/i, "").trim();
    return { command: "outline", args: rest || "build a strong execution outline" };
  }
  if (/^(draft)\b/.test(lower)) {
    const rest = value.replace(/^(draft)\b[:\s-]*/i, "").trim();
    return { command: "draft", args: rest || "telegram-draft | first draft created from Telegram" };
  }
  if (/^(summarize|summary)\b/.test(lower)) {
    const rest = value.replace(/^(summarize|summary)\b[:\s-]*/i, "").trim();
    if (rest) {
      return { command: "summarize", args: rest };
    }
  }
  if (/^(providers|models|tasks)\b/.test(lower)) {
    return { command: lower.split(/\s+/)[0], args: "" };
  }
  return null;
}

function requireWixConfig() {
  const apiKey = process.env.WIX_API_KEY;
  const accountId = process.env.WIX_ACCOUNT_ID;
  if (!apiKey || !accountId) {
    throw new Error("Wix is not configured locally yet.");
  }
  return { apiKey, accountId };
}

function wixHeaders(extra = {}) {
  const { apiKey, accountId } = requireWixConfig();
  return {
    Authorization: apiKey,
    "Content-Type": "application/json",
    "wix-account-id": accountId,
    ...extra
  };
}

function assertSafeCommand(command) {
  const value = String(command || "").trim();
  if (!value) {
    throw new Error("Command is required.");
  }
  for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(value)) {
      throw new Error("That command is blocked in safe mode.");
    }
  }
  return value;
}

function shellExec(command, cwd) {
  return new Promise((resolve) => {
    exec(command, {
      cwd,
      timeout: DEFAULT_TIMEOUT_MS,
      windowsHide: true,
      shell: "powershell.exe",
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      resolve({
        error,
        stdout: stdout.trim(),
        stderr: stderr.trim()
      });
    });
  });
}

async function listFiles(args, roots) {
  const target = args ? resolveAllowedPath(args, roots) : roots[0];
  const entries = await fsp.readdir(target, { withFileTypes: true });
  const items = await Promise.all(
    entries.slice(0, 40).map(async (entry) => {
      const fullPath = path.join(target, entry.name);
      if (entry.isDirectory()) {
        return `[DIR] ${entry.name}`;
      }
      const stats = await fsp.stat(fullPath);
      return `[FILE] ${entry.name} (${formatBytes(stats.size)})`;
    })
  );
  return [`Files in ${target}`, "", ...items].join("\n");
}

async function treeFiles(args, roots) {
  const target = args ? resolveAllowedPath(args, roots) : roots[0];
  const result = await shellExec(`tree "${target}" /A /F`, roots[0]);
  if (!result.stdout) {
    throw new Error(`Could not build a tree for ${target}`);
  }
  return truncateForTelegram(`Tree for ${target}\n\n${result.stdout}`);
}

async function readFileCommand(args, roots) {
  const target = resolveAllowedPath(args, roots);
  const data = await fsp.readFile(target, "utf8");
  return `Reading ${target}\n\n${truncateForTelegram(data)}`;
}

async function fileInfoCommand(args, roots) {
  const target = resolveAllowedPath(args, roots);
  const stats = await fsp.stat(target);
  return [
    `File info for ${target}`,
    `Type: ${stats.isDirectory() ? "directory" : "file"}`,
    `Size: ${stats.isDirectory() ? "n/a" : formatBytes(stats.size)}`,
    `Created: ${stats.birthtime.toISOString()}`,
    `Modified: ${stats.mtime.toISOString()}`
  ].join("\n");
}

async function writeFileCommand(args, roots, appendMode) {
  const [rawPath, ...rest] = String(args || "").split("|");
  const content = rest.join("|").trim();
  if (!rawPath || !content) {
    throw new Error(`Use /${appendMode ? "append" : "write"} path | content`);
  }
  const target = resolveAllowedPath(rawPath.trim(), roots);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  if (appendMode) {
    await fsp.appendFile(target, content, "utf8");
  } else {
    await fsp.writeFile(target, content, "utf8");
  }
  return `${appendMode ? "Appended to" : "Wrote"} ${target}`;
}

async function mkdirCommand(args, roots) {
  const target = resolveAllowedPath(args, roots);
  await fsp.mkdir(target, { recursive: true });
  return `Created directory ${target}`;
}

async function copyCommand(args, roots) {
  const [rawSource, ...rest] = String(args || "").split("|");
  const rawTarget = rest.join("|").trim();
  if (!rawSource || !rawTarget) {
    throw new Error("Use /copy source | target");
  }

  const source = resolveAllowedPath(rawSource.trim(), roots);
  const target = resolveAllowedPath(rawTarget, roots);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.cp(source, target, { recursive: true, force: true });
  return `Copied ${source} to ${target}`;
}

async function moveCommand(args, roots) {
  const [rawSource, ...rest] = String(args || "").split("|");
  const rawTarget = rest.join("|").trim();
  if (!rawSource || !rawTarget) {
    throw new Error("Use /move source | target");
  }

  const source = resolveAllowedPath(rawSource.trim(), roots);
  const target = resolveAllowedPath(rawTarget, roots);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.rename(source, target);
  return `Moved ${source} to ${target}`;
}

async function runCommand(args, roots) {
  if (!args) {
    throw new Error("Use /run your command");
  }

  const safeCommand = assertSafeCommand(args);
  const result = await shellExec(safeCommand, roots[0]);
  const parts = [`Command: ${safeCommand}`, `Working dir: ${roots[0]}`];
  if (result.stdout) {
    parts.push(`STDOUT\n${result.stdout}`);
  }
  if (result.stderr) {
    parts.push(`STDERR\n${result.stderr}`);
  }
  if (result.error) {
    parts.push(`Exit: ${result.error.message}`);
  }
  return truncateForTelegram(parts.join("\n\n"));
}

async function networkOverview() {
  const [gateway, arp, ipconfig] = await Promise.all([
    shellExec("(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1 -ExpandProperty NextHop)", ROOT),
    shellExec("arp -a", ROOT),
    shellExec("Get-NetIPConfiguration | Select-Object InterfaceAlias,IPv4Address,IPv4DefaultGateway | Format-List", ROOT)
  ]);

  return truncateForTelegram([
    "Local network overview",
    "",
    `Gateway: ${gateway.stdout || "unknown"}`,
    "",
    "IP configuration",
    ipconfig.stdout || "No IP configuration found.",
    "",
    "ARP table",
    arp.stdout || "No ARP entries found."
  ].join("\n"));
}

async function currentWifiInfo() {
  const [profiles, currentSsid, publicIp] = await Promise.all([
    shellExec("netsh wlan show profiles", ROOT),
    shellExec("(netsh wlan show interfaces | Select-String '^[ ]*SSID[ ]*:[ ]*(.+)$' | Select-Object -First 1).Matches.Groups[1].Value", ROOT),
    shellExec("(Invoke-RestMethod 'https://api.ipify.org?format=text')", ROOT)
  ]);

  const savedNetworks = (profiles.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("All User Profile"))
    .map((line) => line.split(":").slice(1).join(":").trim())
    .filter(Boolean)
    .slice(0, 10);

  return truncateForTelegram([
    "Wi-Fi status",
    "",
    `Connected SSID: ${currentSsid.stdout || "unknown"}`,
    `Public IP: ${publicIp.stdout || "unknown"}`,
    savedNetworks.length ? `Saved networks:\n${savedNetworks.map((name) => `- ${name}`).join("\n")}` : "Saved networks: none found"
  ].join("\n"));
}

async function getNetworkContext() {
  const [gateway, ipAddress] = await Promise.all([
    shellExec("(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1 -ExpandProperty NextHop)", ROOT),
    shellExec("(Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.IPAddress -notlike '169.*' -and $_.IPAddress -notlike '127.*'} | Select-Object -First 1 -ExpandProperty IPAddress)", ROOT)
  ]);

  const currentIp = (ipAddress.stdout || "").trim();
  const subnetPrefix = currentIp ? currentIp.split(".").slice(0, 3).join(".") : "";
  return {
    gateway: (gateway.stdout || "").trim(),
    currentIp,
    subnetPrefix
  };
}

function describeDevice(device) {
  return [
    `#${device.shortId} ${device.name}`,
    `IP: ${device.ip || "unknown"}`,
    `Source: ${device.source || "manual"}`,
    device.description ? `Notes: ${device.description}` : null,
    device.lastSeenAt ? `Last seen: ${device.lastSeenAt}` : null
  ].filter(Boolean).join("\n");
}

async function scanNetworkDevices() {
  const context = await getNetworkContext();
  if (!context.subnetPrefix) {
    throw new Error("Could not determine the active subnet.");
  }

  const command = [
    `$prefix='${context.subnetPrefix}'`,
    "$targets = 1..24 | ForEach-Object { \"$prefix.$_\" }",
    "$live = foreach ($ip in $targets) { if (Test-Connection -Count 1 -Quiet -TimeoutSeconds 1 $ip) { $ip } }",
    "$live | ForEach-Object { $_ }"
  ].join("; ");
  const result = await shellExec(command, ROOT);
  const ips = result.stdout ? result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
  const arp = await shellExec("arp -a", ROOT);

  const devices = ips.map((ip) => {
    const arpLine = (arp.stdout || "").split(/\r?\n/).find((line) => line.includes(ip)) || "";
    const mac = arpLine.trim().split(/\s+/)[1] || "";
    return {
      id: makeId("device"),
      shortId: ip.split(".").pop(),
      name: `LAN ${ip}`,
      ip,
      mac,
      source: "scan",
      description: "",
      lastSeenAt: nowIso()
    };
  });

  const existing = await readDevices();
  const merged = [...existing.filter((device) => device.source !== "scan"), ...devices];
  await writeDevices(merged);

  return truncateForTelegram([
    `Scanned subnet ${context.subnetPrefix}.0/24`,
    `Gateway: ${context.gateway || "unknown"}`,
    "",
    ...(devices.length
      ? devices.slice(0, 20).map((device) => `- ${device.ip}${device.mac ? ` | ${device.mac}` : ""}`)
      : ["No live devices found in the quick scan window."])
  ].join("\n"));
}

async function listDevices() {
  const devices = await readDevices();
  if (!devices.length) {
    return "No known devices yet.\n\nUse /devicescan or /deviceadd name | ip | notes";
  }
  return truncateForTelegram([
    "Known devices",
    "",
    ...devices.slice(0, 20).map((device) => describeDevice(device))
  ].join("\n\n"));
}

async function addDevice(args) {
  const [rawName, rawIp, ...rest] = String(args || "").split("|");
  const name = String(rawName || "").trim();
  const ip = String(rawIp || "").trim();
  const description = rest.join("|").trim();
  if (!name || !ip) {
    throw new Error("Use /deviceadd name | ip | optional notes");
  }

  const devices = await readDevices();
  const device = {
    id: makeId("device"),
    shortId: makeId("dv").split("-")[1],
    name,
    ip,
    description,
    source: "manual",
    lastSeenAt: null,
    createdAt: nowIso()
  };
  devices.push(device);
  await writeDevices(devices);
  return `Saved device\n\n${describeDevice(device)}`;
}

async function resolveDeviceTarget(value) {
  const target = String(value || "").trim();
  if (!target) {
    throw new Error("A device name, short id, or IP is required.");
  }
  const devices = await readDevices();
  return devices.find((device) =>
    device.shortId === target ||
    device.ip === target ||
    (device.name || "").toLowerCase() === target.toLowerCase()
  ) || null;
}

async function deviceDetail(args) {
  const target = await resolveDeviceTarget(args);
  if (!target) {
    throw new Error(`Could not find device "${args}".`);
  }
  return describeDevice(target);
}

async function devicePing(args) {
  const target = (await resolveDeviceTarget(args)) || { ip: String(args || "").trim(), name: String(args || "").trim() };
  if (!target.ip) {
    throw new Error("Use /deviceping device-name-or-ip");
  }
  const reply = await pingHost(target.ip);
  const devices = await readDevices();
  const updated = devices.map((device) => device.ip === target.ip ? { ...device, lastSeenAt: nowIso() } : device);
  await writeDevices(updated);
  return truncateForTelegram(`Device: ${target.name || target.ip}\n\n${reply}`);
}

async function devicePorts(args) {
  const target = (await resolveDeviceTarget(args)) || { ip: String(args || "").trim(), name: String(args || "").trim() };
  if (!target.ip) {
    throw new Error("Use /deviceports device-name-or-ip");
  }
  const reply = await scanCommonPorts(target.ip);
  return truncateForTelegram(`Device: ${target.name || target.ip}\n\n${reply}`);
}

async function pingHost(rawTarget) {
  const target = String(rawTarget || "").trim();
  if (!target) {
    throw new Error("Use /ping host-or-ip");
  }
  return runCommand(`Test-Connection -Count 2 ${target} | Format-Table -AutoSize`, [ROOT]);
}

async function scanCommonPorts(rawTarget) {
  const target = String(rawTarget || "").trim();
  if (!target) {
    throw new Error("Use /ports host-or-ip");
  }
  const ports = [22, 80, 443, 445, 3389, 8080];
  const checks = await Promise.all(
    ports.map(async (port) => {
      const result = await shellExec(`Test-NetConnection -ComputerName ${target} -Port ${port} -WarningAction SilentlyContinue | Select-Object ComputerName,RemotePort,TcpTestSucceeded | Format-Table -HideTableHeaders`, ROOT);
      return result.stdout || `${target} ${port} false`;
    })
  );
  return truncateForTelegram(["Common port scan", "", ...checks].join("\n"));
}

async function resolveWixSiteId() {
  const payload = await fetch("https://www.wixapis.com/site-list/v2/sites/query", {
    method: "POST",
    headers: wixHeaders(),
    body: JSON.stringify({
      query: {
        paging: { limit: 10, offset: 0 }
      }
    })
  }).then((response) => response.json());

  const sites = Array.isArray(payload.sites) ? payload.sites : [];
  const preferred = sites.find((site) => String(site.status || "").toLowerCase() === "published") || sites[0];
  if (!preferred || !preferred.id) {
    throw new Error("No Wix site found for this account.");
  }
  return { siteId: String(preferred.id), sites };
}

async function wixSummary() {
  const { siteId } = await resolveWixSiteId();
  const [propertiesPayload, urlsPayload] = await Promise.all([
    fetch("https://www.wixapis.com/site-properties/v4/properties", {
      method: "GET",
      headers: wixHeaders({ "wix-site-id": siteId })
    }).then((response) => response.json()),
    fetch("https://www.wixapis.com/site-properties/v4/site-urls", {
      method: "GET",
      headers: wixHeaders({ "wix-site-id": siteId })
    }).then((response) => response.json()).catch(() => ({}))
  ]);

  const properties = propertiesPayload.properties || propertiesPayload;
  const businessProfile = properties.businessProfile || {};
  const businessContact = properties.businessContact || {};
  const urls = []
    .concat(Array.isArray(urlsPayload.urls) ? urlsPayload.urls : [])
    .map((entry) => (typeof entry === "string" ? entry : entry.url || entry.domainName || entry.primaryUrl))
    .filter(Boolean)
    .slice(0, 5);

  return truncateForTelegram([
    "Wix summary",
    "",
    `Site ID: ${siteId}`,
    `Site: ${businessProfile.siteDisplayName || properties.siteDisplayName || "Unknown"}`,
    `Business: ${businessProfile.businessName || properties.businessName || "Unknown"}`,
    `Email: ${businessContact.email || properties.email || "Unknown"}`,
    `Phone: ${businessContact.phone || properties.phone || "Unknown"}`,
    urls.length ? `URLs:\n${urls.map((url) => `- ${url}`).join("\n")}` : "URLs: none returned"
  ].join("\n"));
}

async function wixContacts() {
  const { siteId } = await resolveWixSiteId();
  const payload = await fetch("https://www.wixapis.com/contacts/v4/contacts/query", {
    method: "POST",
    headers: wixHeaders({ "wix-site-id": siteId }),
    body: JSON.stringify({
      query: {
        sort: [{ fieldName: "createdDate", order: "DESC" }],
        paging: { limit: 5, offset: 0 }
      }
    })
  }).then((response) => response.json());

  const contacts = Array.isArray(payload.contacts) ? payload.contacts : [];
  if (!contacts.length) {
    return "No recent Wix contacts returned.";
  }

  return truncateForTelegram([
    "Recent Wix contacts",
    "",
    ...contacts.map((contact) => {
      const info = contact.info || {};
      const emails = Array.isArray(info.emails) ? info.emails : [];
      const phones = Array.isArray(info.phones) ? info.phones : [];
      const email = (emails[0] && emails[0].email) || "no email";
      const phone = (phones[0] && phones[0].phone) || "no phone";
      return `- ${info.name || "Unnamed"} | ${email} | ${phone}`;
    })
  ].join("\n"));
}

async function findFiles(args, roots) {
  const parts = String(args || "").split("|");
  const pattern = (parts[0] || "").trim();
  const rawPath = (parts[1] || "").trim();
  if (!pattern) {
    throw new Error("Use /find pattern or /find pattern | path");
  }

  const target = rawPath ? resolveAllowedPath(rawPath, roots) : roots[0];
  const escapedPattern = pattern.replace(/'/g, "''");
  const escapedTarget = target.replace(/'/g, "''");
  const command = `Get-ChildItem -Path '${escapedTarget}' -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*${escapedPattern}*' } | Select-Object -First ${SEARCH_RESULT_LIMIT} -ExpandProperty FullName`;
  const result = await shellExec(command, roots[0]);
  const lines = result.stdout ? result.stdout.split(/\r?\n/).filter(Boolean) : [];
  if (!lines.length) {
    return `No files matched "${pattern}" in ${target}`;
  }
  return [`Matching files for "${pattern}" in ${target}:`, "", ...lines].join("\n");
}

async function grepFiles(args, roots) {
  const parts = String(args || "").split("|");
  const pattern = (parts[0] || "").trim();
  const rawPath = (parts[1] || "").trim();
  if (!pattern) {
    throw new Error("Use /grep text or /grep text | path");
  }

  const target = rawPath ? resolveAllowedPath(rawPath, roots) : roots[0];
  const escapedPattern = pattern.replace(/'/g, "''");
  const escapedTarget = target.replace(/'/g, "''");
  const command = `Get-ChildItem -Path '${escapedTarget}' -Recurse -File -ErrorAction SilentlyContinue | Select-String -Pattern '${escapedPattern}' -SimpleMatch | Select-Object -First ${SEARCH_RESULT_LIMIT} | ForEach-Object { \\\"$($_.Path):$($_.LineNumber): $($_.Line.Trim())\\\" }`;
  const result = await shellExec(command, roots[0]);
  const lines = result.stdout ? result.stdout.split(/\r?\n/).filter(Boolean) : [];
  if (!lines.length) {
    return `No text matches for "${pattern}" in ${target}`;
  }
  return [`Content matches for "${pattern}" in ${target}:`, "", ...lines].join("\n");
}

async function gitStatus(roots) {
  return runCommand("git status --short", roots);
}

async function gitLog(roots) {
  return runCommand("git log --oneline -5", roots);
}

async function systemInfo(bot, roots) {
  const cwd = roots[0];
  const [nodeVersion, platformInfo] = await Promise.all([
    shellExec("node -v", cwd),
    shellExec("$PSVersionTable.PSVersion.ToString()", cwd)
  ]);

  return [
    `${bot.name} system status`,
    `Primary root: ${cwd}`,
    `Node: ${nodeVersion.stdout || "unknown"}`,
    `PowerShell: ${platformInfo.stdout || "unknown"}`,
    `AI selection: ${selectionSummary(bot)}`,
    `Ollama base: ${bot.ollamaBaseUrl || "not set"}`,
    `Allowed roots: ${roots.length}`
  ].join("\n");
}

async function healthSummary(bot, roots) {
  const cwd = roots[0];
  const [wifi, internetCheck, ollamaCheck, runnerCheck] = await Promise.all([
    shellExec("(netsh wlan show interfaces | Select-String '^[ ]*SSID[ ]*:[ ]*(.+)$' | Select-Object -First 1).Matches.Groups[1].Value", cwd),
    shellExec("Test-NetConnection 1.1.1.1 -Port 443 -WarningAction SilentlyContinue | Select-Object RemoteAddress,TcpTestSucceeded | Format-Table -HideTableHeaders", cwd),
    shellExec("Invoke-RestMethod http://127.0.0.1:11434/api/tags | ConvertTo-Json -Compress", cwd),
    shellExec("Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*telegram-polling-runner.js*' -and $_.CommandLine -like '*--bot " + bot.name + "*' } | Select-Object -First 1 -ExpandProperty ProcessId", cwd)
  ]);

  let ollamaState = "offline";
  try {
    const payload = JSON.parse(ollamaCheck.stdout || "{}");
    const count = Array.isArray(payload.models) ? payload.models.length : 0;
    ollamaState = count ? `online (${count} models)` : "online";
  } catch {}

  return [
    `${bot.name} health`,
    `Runner PID: ${runnerCheck.stdout || "not found"}`,
    `Wi-Fi: ${wifi.stdout || "unknown"}`,
    `Internet: ${internetCheck.stdout ? "reachable" : "unconfirmed"}`,
    `Ollama: ${ollamaState}`,
    `AI selection: ${selectionSummary(bot)}`,
    `Primary root: ${cwd}`
  ].join("\n");
}

async function projectOverview(roots) {
  const cwd = roots[0];
  const [status, recent, files] = await Promise.all([
    shellExec("git status --short", cwd),
    shellExec("git log --oneline -5", cwd),
    fsp.readdir(cwd, { withFileTypes: true }).catch(() => [])
  ]);

  const topLevel = files
    .slice(0, 12)
    .map((entry) => `${entry.isDirectory() ? "[DIR]" : "[FILE]"} ${entry.name}`);

  return truncateForTelegram([
    `Project overview for ${cwd}`,
    "",
    "Top level",
    ...(topLevel.length ? topLevel : ["No files found."]),
    "",
    "Git status",
    status.stdout || "Clean or not a git repo.",
    "",
    "Recent commits",
    recent.stdout || "No commits found."
  ].join("\n"));
}

async function fetchWebPage(rawUrl) {
  const url = String(rawUrl || "").trim();
  if (!url) {
    throw new Error("Use /fetch https://example.com");
  }
  const response = await fetch(url, { method: "GET" });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Fetch failed (${response.status})`);
  }
  const title = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() || "Untitled";
  const body = text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return truncateForTelegram(`Fetched: ${url}\nTitle: ${title}\n\n${body.slice(0, 2800)}`);
}

async function notionStatus() {
  const workspaceId = process.env.NOTION_WORKSPACE_ID || "not set";
  const users = await notionListUsers();
  const people = Array.isArray(users.results) ? users.results : [];
  return [
    "Notion status",
    `Workspace: ${workspaceId}`,
    `Accessible users: ${people.length}`,
    people.length ? `Sample users:\n${people.slice(0, 5).map((user) => `- ${user.name || user.id}`).join("\n")}` : "No users returned.",
    "",
    "Tip: pages and databases must be shared with the integration before the bot can read or write them."
  ].join("\n");
}

function notionPageTitle(page) {
  const properties = page && page.properties ? page.properties : {};
  for (const key of Object.keys(properties)) {
    const value = properties[key];
    if (value && value.type === "title" && Array.isArray(value.title)) {
      const text = value.title.map((part) => part.plain_text).join("").trim();
      if (text) {
        return text;
      }
    }
  }
  return page && page.url ? page.url : page && page.id ? page.id : "Untitled";
}

async function notionFindBestPage(query) {
  const payload = await notionSearch(query || "");
  const results = Array.isArray(payload.results) ? payload.results : [];
  const pages = results.filter((item) => item && item.object === "page");
  if (!pages.length) {
    throw new Error(`No Notion page matched "${query}".`);
  }
  return pages[0];
}

async function notionSearchCommand(query) {
  const payload = await notionSearch(query || "");
  const results = Array.isArray(payload.results) ? payload.results : [];
  if (!results.length) {
    return `No Notion results for "${query || ""}".`;
  }
  return truncateForTelegram([
    `Notion search for "${query}"`,
    "",
    ...results.slice(0, 8).map((item) => {
      return `- ${notionPageTitle(item)}\n  ${item.id}`;
    })
  ].join("\n"));
}

async function notionPageCommand(pageId) {
  const [page, blocks] = await Promise.all([
    notionRetrievePage(pageId),
    notionRetrieveBlockChildren(pageId).catch(() => ({ results: [] }))
  ]);

  const contentPreview = (Array.isArray(blocks.results) ? blocks.results : [])
    .slice(0, 8)
    .map((block) => {
      const richText = block[block.type] && Array.isArray(block[block.type].rich_text) ? block[block.type].rich_text.map((part) => part.plain_text).join("") : "";
      return `- ${block.type}: ${richText || "(no text)"}`;
    });

  return truncateForTelegram([
    "Notion page",
    `ID: ${page.id}`,
    `URL: ${page.url || "n/a"}`,
    "",
    "Blocks",
    ...(contentPreview.length ? contentPreview : ["No block preview returned."])
  ].join("\n"));
}

async function notionOpenCommand(query) {
  const page = await notionFindBestPage(query);
  return notionPageCommand(page.id);
}

async function notionAppendCommand(args) {
  const [rawPageId, ...rest] = String(args || "").split("|");
  const content = rest.join("|").trim();
  if (!rawPageId || !content) {
    throw new Error("Use /notionappend page_id | text");
  }
  await notionAppendToPage(rawPageId.trim(), content);
  return `Appended content to Notion page ${rawPageId.trim()}`;
}

async function notionAppendToMatchCommand(args) {
  const [rawQuery, ...rest] = String(args || "").split("|");
  const query = String(rawQuery || "").trim();
  const content = rest.join("|").trim();
  if (!query || !content) {
    throw new Error("Use /notionappendto page title | text");
  }
  const page = await notionFindBestPage(query);
  await notionAppendToPage(page.id, content);
  return `Appended content to ${notionPageTitle(page)}\n${page.id}`;
}

async function notionCreateCommand(args) {
  const [rawParent, rawTitle, ...rest] = String(args || "").split("|");
  const parentPageId = String(rawParent || "").trim();
  const title = String(rawTitle || "").trim();
  const content = rest.join("|").trim();
  if (!parentPageId || !title) {
    throw new Error("Use /notioncreate parent_page_id | Title | content");
  }
  const page = await notionCreatePage(parentPageId, title, content);
  return `Created Notion page ${page.id}\n${page.url || ""}`.trim();
}

async function notionCreateInMatchCommand(args) {
  const [rawParentQuery, rawTitle, ...rest] = String(args || "").split("|");
  const parentQuery = String(rawParentQuery || "").trim();
  const title = String(rawTitle || "").trim();
  const content = rest.join("|").trim();
  if (!parentQuery || !title) {
    throw new Error("Use /notioncreatein parent title | New Title | content");
  }
  const parentPage = await notionFindBestPage(parentQuery);
  const page = await notionCreatePage(parentPage.id, title, content);
  return `Created Notion page under ${notionPageTitle(parentPage)}\n${page.url || page.id}`;
}

async function notionQueryCommand(dataSourceId) {
  const payload = await notionQueryDataSource(dataSourceId);
  const results = Array.isArray(payload.results) ? payload.results : [];
  if (!results.length) {
    return `No rows returned for data source ${dataSourceId}.`;
  }
  return truncateForTelegram([
    `Notion data source ${dataSourceId}`,
    "",
    ...results.slice(0, 8).map((item) => `- ${item.id}`)
  ].join("\n"));
}

async function notionUsersCommand() {
  const payload = await notionListUsers();
  const results = Array.isArray(payload.results) ? payload.results : [];
  return truncateForTelegram([
    "Notion users",
    "",
    ...results.slice(0, 12).map((user) => `- ${user.name || user.id} (${user.type || "unknown"})`)
  ].join("\n"));
}

async function manusTaskCommand(prompt) {
  if (!prompt) {
    throw new Error("Use /manus your task");
  }
  const task = await manusCreateTask(prompt);
  return truncateForTelegram([
    "Manus task started",
    `ID: ${task.id || task.task_id || "unknown"}`,
    `Status: ${task.status || task.state || "created"}`,
    `Mode: ${process.env.MANUS_MODE || "fast"}`,
    `Profile: ${process.env.MANUS_AGENT_PROFILE || "manus-1.6-lite"}`
  ].join("\n"));
}

async function manusNotionTaskCommand(prompt) {
  const connectorId = process.env.MANUS_NOTION_CONNECTOR_ID || "";
  if (!connectorId) {
    throw new Error("MANUS_NOTION_CONNECTOR_ID is not configured yet.");
  }
  if (!prompt) {
    throw new Error("Use /manusnotion your task");
  }
  const task = await manusCreateConnectedTask(prompt, [
    {
      connector_name: "notion",
      connector_uuid: connectorId
    }
  ]);
  return truncateForTelegram([
    "Manus Notion task started",
    `ID: ${task.id || task.task_id || "unknown"}`,
    `Status: ${task.status || task.state || "created"}`,
    `Connector: notion`,
    `Profile: ${process.env.MANUS_AGENT_PROFILE || "manus-1.6-lite"}`
  ].join("\n"));
}

async function manusStatusCommand(taskId) {
  const task = await manusGetTask(taskId);
  return truncateForTelegram([
    "Manus task status",
    `ID: ${task.id || task.task_id || taskId}`,
    `Status: ${task.status || task.state || "unknown"}`,
    `Prompt: ${String(task.prompt || task.input || "").slice(0, 600) || "n/a"}`
  ].join("\n"));
}

async function manusListCommand() {
  const payload = await manusListTasks();
  const tasks = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.tasks) ? payload.tasks : Array.isArray(payload.results) ? payload.results : [];
  if (!tasks.length) {
    return "No recent Manus tasks returned.";
  }
  return truncateForTelegram([
    "Recent Manus tasks",
    "",
    ...tasks.slice(0, 8).map((task) => `- ${(task.id || task.task_id || "unknown")} | ${task.status || task.state || "unknown"}`)
  ].join("\n"));
}

function selectionSummary(bot) {
  const selection = currentSelection(bot);
  return `${selection.label} | ${selection.model || "auto"}`;
}

function providersSummary(bot) {
  const current = currentSelection(bot);
  return [
    "Configured AI providers",
    "",
    ...describeProfiles(bot).map((profile) => {
      const marker = profile.id === current.id ? "*" : "-";
      return `${marker} ${profile.label} (${profile.id})`;
    }),
    "",
    "Default supervisor brain: Ollama qwen2.5-coder stays the local default unless you switch or delegate.",
    `Active: ${current.label}`,
    `Model: ${current.model || "auto-select cheapest useful model"}`
  ].join("\n");
}

function fallbackSelectionChain(bot, currentId = "") {
  const profiles = configuredProviderProfiles(bot);
  const preferred = ["anthropic", "openrouter", "openai", "cohere", "ollama"];
  const ordered = [];
  for (const provider of preferred) {
    ordered.push(...profiles.filter((profile) => profile.provider === provider && profile.id !== currentId));
  }
  for (const profile of profiles) {
    if (profile.id !== currentId && !ordered.some((entry) => entry.id === profile.id)) {
      ordered.push(profile);
    }
  }
  return ordered;
}

function userFacingErrorMessage(error) {
  const message = error && (error.message || String(error)) ? String(error.message || error) : "Unknown error";
  if (/aborted|aborterror/i.test(message)) {
    return "The AI request timed out before a model finished. The local qwen model is still the default, but if it is busy loading you can retry in a moment or temporarily switch with /provider anthropic or /provider openrouter.";
  }
  return message;
}

function fastChatProfile(bot) {
  const current = currentSelection(bot);
  if (current && current.provider === "ollama") {
    return current;
  }

  const preferred = ["ollama", "anthropic", "openrouter", "openai", "cohere"];
  const profiles = configuredProviderProfiles(bot);
  for (const provider of preferred) {
    const match = profiles.find((profile) => profile.provider === provider);
    if (match) {
      return match;
    }
  }
  return null;
}

function shouldUsePlanner(userText) {
  const text = String(userText || "").trim();
  const lower = text.toLowerCase();
  if (!text) {
    return false;
  }
  if (/^\/\w+/.test(text)) {
    return false;
  }
  if (/[\\/]/.test(text) || /\b(path|file|folder|directory|repo|git|wix|notion|manus|network|wifi|port|ping|schedule|model|provider|task|tasks|document|doc|sheet|code|run|build|create|write|append|read|find|grep|move|copy|zip|analyze|intake|casepack|autopilot|squad|delegate|supervisor)\b/i.test(lower)) {
    return true;
  }
  if (text.length > 280) {
    return true;
  }
  return false;
}

async function listModels(bot, rawSelector = "") {
  const overrideProfile = rawSelector ? findProfile(bot, rawSelector) : null;
  const { selection, models } = await listProviderModels(bot, overrideProfile ? { profileId: overrideProfile.id } : {});
  const current = currentSelection(bot);
  const activeModel = selection.id === current.id ? current.model : "";
  return [
    `Available models for ${selection.label}`,
    "",
    ...(models.length
      ? models.slice(0, 60).map((model) => `${model === activeModel ? "*" : "-"} ${model}`)
      : ["No models returned."]),
    "",
    `Selection key: ${selection.id}`
  ].join("\n");
}

async function askModel(bot, prompt, systemOverride, overrideSelection) {
  if (!prompt) {
    throw new Error("Prompt is required.");
  }
  try {
    const result = await generateText(bot, prompt, systemOverride, overrideSelection || {});
    return String(result.text || "").trim();
  } catch (error) {
    if (overrideSelection && overrideSelection.strict) {
      throw error;
    }
    const current = currentSelection(bot, overrideSelection || {});
    for (const profile of fallbackSelectionChain(bot, current.id)) {
      try {
        const fallback = await generateText(bot, prompt, systemOverride, {
          profileId: profile.id
        });
        return String(fallback.text || "").trim();
      } catch {}
    }
    throw new Error(userFacingErrorMessage(error));
  }
}

function currentChatMode(state) {
  return state && state.mode === "build" ? "build" : "read";
}

function withChatMode(state, mode) {
  return {
    ...(state || { messages: [] }),
    mode: mode === "build" ? "build" : "read",
    capture: state && state.capture ? state.capture : null
  };
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || `file-${Date.now()}`;
}

function timestampLabel() {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${mi}`;
}

function defaultDesktopIntakePath(roots, label = "intake") {
  const desktopRoot = roots.find((root) => root.toLowerCase().endsWith(`${path.sep}desktop`)) || roots[0];
  return path.join(desktopRoot, "ZEN Intake", `${slugify(label)}-${timestampLabel()}.txt`);
}

async function generateArtifact(bot, prompt, systemPrompt, overrideSelection) {
  const output = await askModel(bot, prompt, systemPrompt, overrideSelection);
  return String(output || "").replace(/^```[a-zA-Z]*\s*/g, "").replace(/```$/g, "").trim();
}

async function writeGeneratedArtifact(bot, roots, args, systemPrompt, promptLabel) {
  const [rawPath, ...rest] = String(args || "").split("|");
  const targetPath = String(rawPath || "").trim();
  const prompt = rest.join("|").trim();
  if (!targetPath || !prompt) {
    throw new Error(`Use /${promptLabel} path | prompt`);
  }

  const content = await generateArtifact(bot, prompt, systemPrompt);
  await writeFileCommand(`${targetPath} | ${content}`, roots, false);
  return `Created ${targetPath}`;
}

async function replaceInFileCommand(args, roots) {
  const [rawPath, rawOld, ...rest] = String(args || "").split("|");
  const targetPath = String(rawPath || "").trim();
  const oldText = String(rawOld || "");
  const newText = rest.join("|");
  if (!targetPath || !oldText) {
    throw new Error("Use /replace path | old text | new text");
  }
  const target = resolveAllowedPath(targetPath, roots);
  const source = await fsp.readFile(target, "utf8");
  if (!source.includes(oldText)) {
    throw new Error("The target text was not found in that file.");
  }
  await fsp.writeFile(target, source.replace(oldText, newText), "utf8");
  return `Updated ${target}`;
}

async function zipPathCommand(args, roots) {
  const rawPath = String(args || "").trim();
  if (!rawPath) {
    throw new Error("Use /zip path");
  }
  const target = resolveAllowedPath(rawPath, roots);
  const zipTarget = `${target}.zip`;
  await shellExec(`if (Test-Path '${zipTarget.replace(/'/g, "''")}') { Remove-Item '${zipTarget.replace(/'/g, "''")}' -Force }; Compress-Archive -Path '${target.replace(/'/g, "''")}' -DestinationPath '${zipTarget.replace(/'/g, "''")}' -Force`, roots[0]);
  return `Created archive ${zipTarget}`;
}

function defaultDesktopTaskDir(roots, label = "agent-task") {
  const desktopRoot = roots.find((root) => root.toLowerCase().endsWith(`${path.sep}desktop`)) || roots[0];
  return path.join(desktopRoot, "ZEN Agent Jobs", `${slugify(label)}-${timestampLabel()}`);
}

function defaultDesktopDocPath(roots, label = "document") {
  const desktopRoot = roots.find((root) => root.toLowerCase().endsWith(`${path.sep}desktop`)) || roots[0];
  return path.join(desktopRoot, "ZEN Docs", `${slugify(label)}-${timestampLabel()}.md`);
}

async function createDocumentCommand(args, roots) {
  const [rawTitle, ...rest] = String(args || "").split("|");
  const title = String(rawTitle || "").trim();
  const content = rest.join("|").trim();
  if (!title) {
    throw new Error("Use /newdoc title | optional content");
  }
  const target = defaultDesktopDocPath(roots, title);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const body = content
    ? `# ${title}\n\n${content}\n`
    : `# ${title}\n\nCreated from Telegram on ${new Date().toLocaleString()}.\n`;
  await fsp.writeFile(target, body, "utf8");
  return `Created document\n${target}`;
}

async function listRecentDocuments(roots, rawPath = "") {
  if (String(rawPath || "").trim()) {
    return listFiles(rawPath, roots);
  }
  const candidates = [
    roots.find((root) => root.toLowerCase().endsWith(`${path.sep}desktop`)) ? path.join(roots.find((root) => root.toLowerCase().endsWith(`${path.sep}desktop`)), "ZEN Docs") : "",
    roots.find((root) => root.toLowerCase().endsWith(`${path.sep}desktop`)) ? path.join(roots.find((root) => root.toLowerCase().endsWith(`${path.sep}desktop`)), "ZEN Intake") : "",
    roots.find((root) => root.toLowerCase().endsWith(`${path.sep}desktop`)) ? path.join(roots.find((root) => root.toLowerCase().endsWith(`${path.sep}desktop`)), "ZEN Agent Jobs") : ""
  ].filter(Boolean);

  const items = [];
  for (const folder of candidates) {
    if (!fs.existsSync(folder)) {
      continue;
    }
    const entries = await fsp.readdir(folder, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(folder, entry.name);
      const stats = await fsp.stat(fullPath);
      items.push({
        fullPath,
        name: entry.name,
        isDirectory: entry.isDirectory(),
        modifiedAt: stats.mtime.getTime()
      });
    }
  }

  if (!items.length) {
    return "No recent documents yet.\n\nUse /newdoc title | content or /intake name | objective";
  }

  const sorted = items.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, 20);
  return [
    "Recent documents and work folders",
    "",
    ...sorted.map((item) => `${item.isDirectory ? "[DIR]" : "[FILE]"} ${item.fullPath}`)
  ].join("\n");
}

async function workOnDocumentCommand(bot, token, chatId, roots, args) {
  const [rawPath, ...rest] = String(args || "").split("|");
  const targetPath = String(rawPath || "").trim();
  const objective = rest.join("|").trim();
  if (!targetPath) {
    throw new Error("Use /workon path | objective");
  }
  const resolved = resolveAllowedPath(targetPath, roots);
  return startAutopilotTask(bot, token, chatId, "doc", resolved, objective || "Read this document, improve it, and build a strong work pack.");
}

async function extractSpreadsheetText(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const parts = [];
  for (const sheetName of workbook.SheetNames.slice(0, 3)) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false }).slice(0, 40);
    parts.push(`Sheet: ${sheetName}`);
    parts.push(
      rows
        .map((row) => (Array.isArray(row) ? row.map((cell) => String(cell ?? "")).join("\t") : String(row || "")))
        .join("\n")
    );
  }
  return parts.join("\n\n").slice(0, TASK_SOURCE_MAX_CHARS);
}

async function extractPdfText(filePath) {
  const buffer = await fsp.readFile(filePath);
  const payload = await pdfParse(buffer);
  return String(payload.text || "").slice(0, TASK_SOURCE_MAX_CHARS);
}

async function extractDocxText(filePath) {
  const payload = await mammoth.extractRawText({ path: filePath });
  return String(payload.value || "").slice(0, TASK_SOURCE_MAX_CHARS);
}

async function extractFileText(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".xlsx" || extension === ".xls" || extension === ".csv" || extension === ".tsv") {
    return extractSpreadsheetText(filePath);
  }
  if (extension === ".pdf") {
    return extractPdfText(filePath);
  }
  if (extension === ".docx") {
    return extractDocxText(filePath);
  }
  const buffer = await fsp.readFile(filePath);
  return buffer.toString("utf8").slice(0, TASK_SOURCE_MAX_CHARS);
}

async function collectAgentSource(bot, roots, type, target) {
  const value = String(target || "").trim();
  if (!value) {
    return { title: "Prompt-only task", body: "" };
  }

  if (type === "site" && value.toLowerCase() === "wix") {
    const [summary, contacts] = await Promise.all([wixSummary(), wixContacts().catch(() => "No recent contacts.")]);
    return {
      title: "Wix site context",
      body: `${summary}\n\n${contacts}`.slice(0, TASK_SOURCE_MAX_CHARS)
    };
  }

  if (/^https?:\/\//i.test(value)) {
    const page = await fetchWebPage(value);
    return {
      title: value,
      body: page.slice(0, TASK_SOURCE_MAX_CHARS)
    };
  }

  const resolved = resolveAllowedPath(value, roots);
  const stats = await fsp.stat(resolved);
  if (stats.isDirectory()) {
    const listing = await treeFiles(value, roots);
    return {
      title: resolved,
      body: listing.slice(0, TASK_SOURCE_MAX_CHARS),
      resolvedPath: resolved
    };
  }

  return {
    title: path.basename(resolved),
    body: await extractFileText(resolved),
    resolvedPath: resolved
  };
}

function taskTypePrompt(type) {
  if (type === "doc") {
    return "Analyze the source document and produce a detailed brief, concrete action plan, deliverable drafts, and a short execution checklist.";
  }
  if (type === "sheet") {
    return "Analyze the spreadsheet data and produce insights, risks, patterns, action recommendations, and a concise operator summary.";
  }
  if (type === "site") {
    return "Analyze the site/app context and produce an audit, improvement roadmap, execution plan, and ready-to-use content ideas.";
  }
  return "Analyze the input and produce a high-value brief, a practical plan, and useful deliverables.";
}

function configuredProviderProfiles(bot) {
  return describeProfiles(bot).filter((profile) => profile.configured !== false);
}

function providerPriorityByTask(type) {
  if (type === "doc") {
    return ["anthropic", "openai", "openrouter", "cohere", "ollama"];
  }
  if (type === "sheet") {
    return ["openai", "cohere", "openrouter", "anthropic", "ollama"];
  }
  if (type === "site") {
    return ["ollama", "openrouter", "openai", "anthropic", "cohere"];
  }
  return ["ollama", "anthropic", "openrouter", "openai", "cohere"];
}

function recommendedProfiles(bot, type, count = 3) {
  const configured = configuredProviderProfiles(bot);
  const priority = providerPriorityByTask(type);
  const ranked = [];
  for (const provider of priority) {
    ranked.push(...configured.filter((profile) => profile.provider === provider));
  }
  for (const profile of configured) {
    if (!ranked.some((entry) => entry.id === profile.id)) {
      ranked.push(profile);
    }
  }
  return ranked.slice(0, count);
}

async function resolveProfileModel(bot, profile) {
  try {
    const listed = await listProviderModels(bot, { profileId: profile.id });
    return pickCheapestUsefulModel(profile.provider, listed.models) || profile.defaultModel || "";
  } catch {
    return profile.defaultModel || "";
  }
}

function capabilitySummaryText(bot) {
  const current = currentSelection(bot);
  const providerLine = configuredProviderProfiles(bot)
    .map((profile) => `${profile.id}${profile.id === current.id ? " [active]" : ""}`)
    .join(", ");
  return [
    "Capabilities",
    "",
    `Default supervisor: ollama:local | ${bot.ollamaModel || "qwen2.5-coder:7b"}`,
    `Current active AI: ${current.id} | ${current.model || "auto"}`,
    "Remote resiliency: if the local model path fails, the bot can fall back to configured cloud providers for the conversational supervisor flow.",
    `Providers: ${providerLine}`,
    "Best task commands: /docagent, /sheetagent, /siteagent, /supervisor, /delegate, /autopilot, /squad",
    "Useful controls: /providers, /models, /modeluse, /tasks, /taskstatus, /scheduleadd",
    "Core integrations: files, git, network, Wix, Notion, Manus"
  ].join("\n");
}

function describeAgentTask(task) {
  return [
    `#${task.shortId} ${task.type.toUpperCase()} ${task.mode === "squad" ? "squad" : "agent"}`,
    `Status: ${task.status}`,
    `Target: ${task.target || "prompt only"}`,
    `Objective: ${task.objective}`,
    `AI: ${task.providerLabel || task.providerId || "unknown"} | ${task.model || "auto"}`,
    Array.isArray(task.providersUsed) && task.providersUsed.length ? `Providers used: ${task.providersUsed.join(", ")}` : null,
    task.outputDir ? `Output: ${task.outputDir}` : null,
    task.startedAt ? `Started: ${task.startedAt}` : null,
    task.completedAt ? `Completed: ${task.completedAt}` : null,
    task.error ? `Error: ${task.error}` : null
  ].filter(Boolean).join("\n");
}

async function updateAgentTask(taskId, updater) {
  const tasks = await readAgentTasks();
  const index = tasks.findIndex((task) => task.id === taskId);
  if (index < 0) {
    throw new Error(`Could not find task ${taskId}`);
  }
  tasks[index] = typeof updater === "function" ? updater(tasks[index]) : { ...tasks[index], ...updater };
  await writeAgentTasks(tasks);
  return tasks[index];
}

async function createAgentTaskRecord(bot, chatId, type, target, objective) {
  const selection = currentSelection(bot);
  let modelName = selection.model || "";
  if (!modelName) {
    try {
      const listed = await listProviderModels(bot, { profileId: selection.id });
      modelName = pickCheapestUsefulModel(selection.provider, listed.models) || "";
    } catch {}
  }
  const task = {
    id: makeId("task"),
    shortId: makeId("job").split("-")[1],
    botId: bot.id,
    chatId: String(chatId),
    mode: "single",
    type,
    target: String(target || "").trim(),
    objective: String(objective || "").trim() || "Create a practical work pack and actionable next steps.",
    providerId: selection.id,
    providerLabel: selection.label,
    model: modelName,
    status: "queued",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    startedAt: null,
    completedAt: null,
    outputDir: "",
    outputs: [],
    summary: "",
    error: ""
  };
  const tasks = await readAgentTasks();
  tasks.push(task);
  await writeAgentTasks(tasks);
  return task;
}

async function createAgentTaskRecordWithSelection(bot, chatId, type, target, objective, profileToken, modelName) {
  const profile = findProfile(bot, profileToken);
  if (!profile) {
    throw new Error(`Unknown provider profile "${profileToken}"`);
  }
  let nextModel = String(modelName || "").trim();
  if (!nextModel) {
    try {
      const listed = await listProviderModels(bot, { profileId: profile.id });
      nextModel = pickCheapestUsefulModel(profile.provider, listed.models) || profile.defaultModel || "";
    } catch {
      nextModel = profile.defaultModel || "";
    }
  }
  const task = {
    id: makeId("task"),
    shortId: makeId("job").split("-")[1],
    botId: bot.id,
    chatId: String(chatId),
    mode: "single",
    type,
    target: String(target || "").trim(),
    objective: String(objective || "").trim() || "Create a practical work pack and actionable next steps.",
    providerId: profile.id,
    providerLabel: profile.label,
    model: nextModel,
    status: "queued",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    startedAt: null,
    completedAt: null,
    outputDir: "",
    outputs: [],
    summary: "",
    error: ""
  };
  const tasks = await readAgentTasks();
  tasks.push(task);
  await writeAgentTasks(tasks);
  return task;
}

async function createSquadTaskRecord(bot, chatId, type, target, objective) {
  const task = {
    id: makeId("task"),
    shortId: makeId("job").split("-")[1],
    botId: bot.id,
    chatId: String(chatId),
    mode: "squad",
    type,
    target: String(target || "").trim(),
    objective: String(objective || "").trim() || "Run a multi-agent comparison and create a strong consensus work pack.",
    providerId: "ollama:local",
    providerLabel: "Squad Supervisor",
    model: bot.ollamaModel || "qwen2.5-coder:7b",
    status: "queued",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    startedAt: null,
    completedAt: null,
    outputDir: "",
    outputs: [],
    summary: "",
    error: ""
  };
  const tasks = await readAgentTasks();
  tasks.push(task);
  await writeAgentTasks(tasks);
  return task;
}

function splitIntoChunks(text, maxSize = 7000) {
  const source = String(text || "");
  const chunks = [];
  for (let index = 0; index < source.length; index += maxSize) {
    chunks.push(source.slice(index, index + maxSize));
  }
  return chunks.length ? chunks : [""];
}

async function summarizeLargeText(bot, text, objective) {
  const chunks = splitIntoChunks(text, 7000).slice(0, 12);
  const summaries = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const summary = await askModel(
      bot,
      [
        `Objective: ${objective || "Create a highly detailed factual plan and drafts."}`,
        `Chunk ${index + 1} of ${chunks.length}`,
        "",
        "Extract the most important facts, timeline items, actors, risks, asks, and draftable communications from this text.",
        "Stay factual and concise.",
        "",
        chunk
      ].join("\n"),
      "You are a careful strategic analyst. Summarize raw source material into crisp factual bullets for later planning. Do not give legal advice."
    );
    summaries.push(`Chunk ${index + 1}\n${summary}`);
  }

  return summaries.join("\n\n");
}

async function writeSimplePdf(filePath, title, body) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 48, size: "LETTER" });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);
    doc.fontSize(18).text(title || "Report");
    doc.moveDown();
    doc.fontSize(10).text(String(body || "").replace(/[#*_`>-]/g, ""), {
      width: 500,
      lineGap: 4
    });
    doc.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

async function generateCaseworkPack(bot, roots, sourcePath, objective) {
  const source = await fsp.readFile(sourcePath, "utf8");
  const digest = await summarizeLargeText(bot, source, objective);
  const baseName = sourcePath.replace(/\.[^.]+$/, "");
  const roomDir = `${baseName}-room`;

  const commonPrompt = [
    `Objective: ${objective || "Create a detailed factual plan, chronology, and ready-to-use drafts."}`,
    "",
    "Use the summarized source material below. Be extremely detailed, practical, and organized.",
    "Keep everything factual, non-defamatory, and focused on documentation, communication, scenario planning, and next steps.",
    "Do not present legal advice. Do not invent facts.",
    "",
    digest
  ].join("\n");

  const outline = await generateArtifact(
    bot,
    `${commonPrompt}\n\nCreate a markdown outline with sections for chronology, main facts, risks, leverage points, evidence to preserve, and next actions.`,
    "Return only markdown. Write a sharp, highly organized outline for a complex workplace dispute."
  );
  const plan = await generateArtifact(
    bot,
    `${commonPrompt}\n\nCreate a detailed markdown action plan with immediate steps, 7-day steps, scenario planning, documentation strategy, meeting preparation, and follow-up tasks.`,
    "Return only markdown. Write an operational plan that a real person can follow under pressure."
  );
  const emails = await generateArtifact(
    bot,
    `${commonPrompt}\n\nCreate several copy-paste-ready draft emails and messages. Include a factual update email, a clarification request, a confirmation-after-meeting email, and a preservation-of-record style message. Make them professional and calm.`,
    "Return only markdown. Write polished email drafts that are factual, controlled, and easy to copy and use."
  );
  const scenarios = await generateArtifact(
    bot,
    `${commonPrompt}\n\nCreate a detailed scenario map covering likely responses from the other side, what each may signal, and how to respond calmly and strategically.`,
    "Return only markdown. Write a highly practical scenario and response guide."
  );
  const timeline = await generateArtifact(
    bot,
    `${commonPrompt}\n\nCreate a detailed chronology and evidence timeline with dated bullets, actors, documents, unresolved questions, and follow-up proof to gather.`,
    "Return only markdown. Write a strong chronology and evidence timeline."
  );
  const brief = await generateArtifact(
    bot,
    `${commonPrompt}\n\nCreate a concise but high-impact executive briefing memo that summarizes the issue, current risk, immediate asks, and what to say in the next meeting.`,
    "Return only markdown. Write a polished executive briefing memo."
  );
  const snippets = await generateArtifact(
    bot,
    `${commonPrompt}\n\nCreate a practical snippets document with short copy-paste talking points, meeting phrases, boundary-setting lines, and message fragments.`,
    "Return only markdown. Write quick-use snippets that are calm, factual, and strategic."
  );

  const outputFiles = [
    path.join(roomDir, "outline.md"),
    path.join(roomDir, "plan.md"),
    path.join(roomDir, "emails.md"),
    path.join(roomDir, "scenarios.md"),
    path.join(roomDir, "timeline.md"),
    path.join(roomDir, "briefing.md"),
    path.join(roomDir, "snippets.md"),
    path.join(roomDir, "briefing.pdf")
  ];

  await fsp.mkdir(path.dirname(outputFiles[0]), { recursive: true });
  await fsp.writeFile(outputFiles[0], outline, "utf8");
  await fsp.writeFile(outputFiles[1], plan, "utf8");
  await fsp.writeFile(outputFiles[2], emails, "utf8");
  await fsp.writeFile(outputFiles[3], scenarios, "utf8");
  await fsp.writeFile(outputFiles[4], timeline, "utf8");
  await fsp.writeFile(outputFiles[5], brief, "utf8");
  await fsp.writeFile(outputFiles[6], snippets, "utf8");
  await writeSimplePdf(outputFiles[7], "Case Briefing", brief);

  return {
    sourcePath,
    roomDir,
    outputFiles
  };
}

async function startIntakeSession(args, roots) {
  const [rawTarget, ...rest] = String(args || "").split("|");
  const targetOrLabel = String(rawTarget || "").trim();
  const objective = rest.join("|").trim();
  const looksLikePath = /[\\/]|\.txt$|\.md$|^desktop[\\/]/i.test(targetOrLabel);
  const resolvedPath = targetOrLabel
    ? resolveAllowedPath(looksLikePath ? targetOrLabel : defaultDesktopIntakePath(roots, targetOrLabel), roots)
    : resolveAllowedPath(defaultDesktopIntakePath(roots), roots);

  await fsp.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fsp.writeFile(resolvedPath, "", "utf8");

  return {
    capture: {
      targetPath: resolvedPath,
      objective: objective || "Create a detailed factual outline, plan, scenarios, and copy-paste-ready email drafts from this intake.",
      startedAt: nowIso(),
      chunks: 0
    },
    message: [
      "Intake capture started.",
      `File: ${resolvedPath}`,
      "",
      "Paste your text in one or more messages.",
      "When you're done, send /capturedone to generate the strategy pack."
    ].join("\n")
  };
}

async function appendCaptureText(state, text) {
  const capture = state && state.capture;
  if (!capture || !capture.targetPath) {
    throw new Error("No active intake session.");
  }
  await fsp.mkdir(path.dirname(capture.targetPath), { recursive: true });
  await fsp.appendFile(capture.targetPath, `${text}\n\n`, "utf8");
  return {
    ...state,
    capture: {
      ...capture,
      chunks: Number(capture.chunks || 0) + 1,
      updatedAt: nowIso()
    }
  };
}

async function finishCaptureSession(bot, roots, state) {
  const capture = state && state.capture;
  if (!capture || !capture.targetPath) {
    throw new Error("No active intake session.");
  }
  const pack = await generateCaseworkPack(bot, roots, capture.targetPath, capture.objective);
  return {
    state: {
      ...state,
      capture: null
    },
    message: [
      "Intake saved and case room generated.",
      `Source: ${pack.sourcePath}`,
      `Room: ${pack.roomDir}`,
      "",
      ...pack.outputFiles.map((filePath) => `- ${filePath}`)
    ].join("\n")
  };
}

async function cancelCaptureSession(state) {
  if (!state || !state.capture) {
    throw new Error("No active intake session.");
  }
  return {
    ...state,
    capture: null
  };
}

async function analyzeFileCommand(bot, roots, args) {
  const [rawPath, ...rest] = String(args || "").split("|");
  const targetPath = String(rawPath || "").trim();
  const objective = rest.join("|").trim();
  if (!targetPath) {
    throw new Error("Use /analyze path | objective");
  }
  const resolved = resolveAllowedPath(targetPath, roots);
  const pack = await generateCaseworkPack(bot, roots, resolved, objective);
  return [
    "Case room generated.",
    `Source: ${pack.sourcePath}`,
    `Room: ${pack.roomDir}`,
    "",
    ...pack.outputFiles.map((filePath) => `- ${filePath}`)
  ].join("\n");
}

async function runAgentTaskWorkflow(bot, roots, task) {
  const source = await collectAgentSource(bot, roots, task.type, task.target);
  const outputDir = defaultDesktopTaskDir(roots, `${task.type}-${task.target || "prompt"}`);
  const sourceFile = path.join(outputDir, "source.txt");
  const briefFile = path.join(outputDir, "brief.md");
  const planFile = path.join(outputDir, "plan.md");
  const deliverablesFile = path.join(outputDir, "deliverables.md");
  const checklistFile = path.join(outputDir, "checklist.md");
  const briefPdfFile = path.join(outputDir, "brief.pdf");
  const zipFile = `${outputDir}.zip`;

  await fsp.mkdir(outputDir, { recursive: true });
  await fsp.writeFile(sourceFile, `${source.title}\n\n${source.body}`.trim(), "utf8");

  const context = [
    `Task type: ${task.type}`,
    `Objective: ${task.objective}`,
    `Target: ${task.target || "prompt only"}`,
    `Task guidance: ${taskTypePrompt(task.type)}`,
    "",
    "Source material:",
    source.body || "(no source text provided)"
  ].join("\n");
  const aiOverride = {
    profileId: task.providerId,
    model: task.model
  };

  const brief = await generateArtifact(
    bot,
    `${context}\n\nWrite a detailed executive brief in markdown with the current state, what matters most, risks, and best next moves.`,
    "Return only markdown. Produce a polished, structured brief that is practical and easy to use.",
    aiOverride
  );
  const plan = await generateArtifact(
    bot,
    `${context}\n\nWrite a detailed execution plan in markdown with phases, concrete actions, dependencies, and recommended sequencing.`,
    "Return only markdown. Produce a highly actionable execution plan.",
    aiOverride
  );
  const deliverables = await generateArtifact(
    bot,
    `${context}\n\nCreate useful deliverables for this task in markdown. Include drafts, suggested content, tables, templates, or structured outputs the user can reuse immediately.`,
    "Return only markdown. Produce practical deliverables the user can immediately work from.",
    aiOverride
  );
  const checklist = await generateArtifact(
    bot,
    `${context}\n\nCreate a concise operator checklist in markdown with short follow-up items, owners, and completion cues.`,
    "Return only markdown. Produce a short but sharp checklist.",
    aiOverride
  );

  await fsp.writeFile(briefFile, brief, "utf8");
  await fsp.writeFile(planFile, plan, "utf8");
  await fsp.writeFile(deliverablesFile, deliverables, "utf8");
  await fsp.writeFile(checklistFile, checklist, "utf8");
  await writeSimplePdf(briefPdfFile, `${task.type.toUpperCase()} Agent Brief`, brief);
  await shellExec(`if (Test-Path '${zipFile.replace(/'/g, "''")}') { Remove-Item '${zipFile.replace(/'/g, "''")}' -Force }; Compress-Archive -Path '${outputDir.replace(/'/g, "''")}\\*' -DestinationPath '${zipFile.replace(/'/g, "''")}' -Force`, roots[0]);

  return {
    outputDir,
    outputs: [sourceFile, briefFile, planFile, deliverablesFile, checklistFile, briefPdfFile, zipFile],
    summary: brief.slice(0, 1200)
  };
}

async function runSingleProviderPass(bot, task, context, profile, outputDir) {
  const model = await resolveProfileModel(bot, profile);
  const override = {
    profileId: profile.id,
    model,
    strict: true
  };
  const analysis = await generateArtifact(
    bot,
    `${context}\n\nProduce your strongest markdown work product for this assignment. Include diagnosis, recommended strategy, concrete actions, and reusable deliverables.`,
    "Return only markdown. Produce a practical, detailed, high-value output tuned to your strengths.",
    override
  );
  const target = path.join(outputDir, `${profile.provider}-${slugify(profile.profile || "default")}.md`);
  await fsp.writeFile(target, analysis, "utf8");
  return {
    profileId: profile.id,
    provider: profile.provider,
    label: profile.label,
    model,
    filePath: target,
    analysis
  };
}

async function runSquadTaskWorkflow(bot, roots, task) {
  const source = await collectAgentSource(bot, roots, task.type, task.target);
  const outputDir = defaultDesktopTaskDir(roots, `squad-${task.type}-${task.target || "prompt"}`);
  const sourceFile = path.join(outputDir, "source.txt");
  const consensusFile = path.join(outputDir, "consensus.md");
  const planFile = path.join(outputDir, "execution-plan.md");
  const comparisonFile = path.join(outputDir, "provider-comparison.md");
  const handoffFile = path.join(outputDir, "handoff.md");
  const briefPdfFile = path.join(outputDir, "consensus.pdf");
  const zipFile = `${outputDir}.zip`;
  const providersDir = path.join(outputDir, "providers");

  await fsp.mkdir(providersDir, { recursive: true });
  await fsp.writeFile(sourceFile, `${source.title}\n\n${source.body}`.trim(), "utf8");

  const context = [
    `Task type: ${task.type}`,
    `Objective: ${task.objective}`,
    `Target: ${task.target || "prompt only"}`,
    `Task guidance: ${taskTypePrompt(task.type)}`,
    "",
    "Source material:",
    source.body || "(no source text provided)"
  ].join("\n");

  const selectedProfiles = recommendedProfiles(bot, task.type, 3);
  const providerOutputs = [];
  for (const profile of selectedProfiles) {
    providerOutputs.push(await runSingleProviderPass(bot, task, context, profile, providersDir));
  }

  const combined = providerOutputs
    .map((output) => [`Provider: ${output.label}`, `Model: ${output.model || "auto"}`, "", output.analysis].join("\n"))
    .join("\n\n---\n\n");

  const supervisorOverride = {
    profileId: "ollama:local",
    model: bot.ollamaModel || "qwen2.5-coder:7b"
  };

  const consensus = await generateArtifact(
    bot,
    `${context}\n\nBelow are several provider outputs for the same assignment.\n\n${combined}\n\nSynthesize them into one strong consensus brief. Highlight agreement, useful disagreements, the best insights, and the recommended final direction.`,
    "Return only markdown. You are the local supervisor using qwen2.5-coder. Merge multiple model outputs into a coherent, practical brief.",
    supervisorOverride
  );
  const plan = await generateArtifact(
    bot,
    `${context}\n\nUsing the provider outputs below, produce a final execution plan with phases, next steps, sequencing, and quick wins.\n\n${combined}`,
    "Return only markdown. Produce a practical execution plan from multiple agent outputs.",
    supervisorOverride
  );
  const comparison = await generateArtifact(
    bot,
    `${context}\n\nCompare the strengths, blind spots, and best use cases of each provider output below. Make it easy for the user to understand why different models were useful.\n\n${combined}`,
    "Return only markdown. Create a crisp comparison memo across providers.",
    supervisorOverride
  );
  const handoff = await generateArtifact(
    bot,
    `${context}\n\nUsing the provider outputs below, create a short handoff note with the exact next actions, files to open, and commands or follow-ups the user should run next.\n\n${combined}`,
    "Return only markdown. Create a concise operator handoff.",
    supervisorOverride
  );

  await fsp.writeFile(consensusFile, consensus, "utf8");
  await fsp.writeFile(planFile, plan, "utf8");
  await fsp.writeFile(comparisonFile, comparison, "utf8");
  await fsp.writeFile(handoffFile, handoff, "utf8");
  await writeSimplePdf(briefPdfFile, "Squad Consensus Brief", consensus);
  await shellExec(`if (Test-Path '${zipFile.replace(/'/g, "''")}') { Remove-Item '${zipFile.replace(/'/g, "''")}' -Force }; Compress-Archive -Path '${outputDir.replace(/'/g, "''")}\\*' -DestinationPath '${zipFile.replace(/'/g, "''")}' -Force`, roots[0]);

  return {
    outputDir,
    outputs: [sourceFile, consensusFile, planFile, comparisonFile, handoffFile, briefPdfFile, zipFile, ...providerOutputs.map((output) => output.filePath)],
    summary: consensus.slice(0, 1200),
    providersUsed: providerOutputs.map((output) => `${output.label} | ${output.model || "auto"}`)
  };
}

async function runAgentTaskInBackground(bot, token, taskId) {
  if (ACTIVE_AGENT_TASKS.has(taskId)) {
    return;
  }
  ACTIVE_AGENT_TASKS.add(taskId);

  try {
    let task = await updateAgentTask(taskId, (current) => ({
      ...current,
      status: "running",
      startedAt: nowIso(),
      updatedAt: nowIso(),
      error: ""
    }));
    const roots = getAllowedRoots(bot);
    const result = task.mode === "squad" ? await runSquadTaskWorkflow(bot, roots, task) : await runAgentTaskWorkflow(bot, roots, task);
    task = await updateAgentTask(taskId, (current) => ({
      ...current,
      status: "completed",
      completedAt: nowIso(),
      updatedAt: nowIso(),
      outputDir: result.outputDir,
      outputs: result.outputs,
      summary: result.summary,
      providersUsed: result.providersUsed || current.providersUsed || []
    }));

    await sendTelegramText(
      token,
      task.chatId,
      [
        `${task.mode === "squad" ? "Squad" : "Agent"} task ${task.shortId} finished.`,
        `Type: ${task.type}`,
        `Target: ${task.target || "prompt only"}`,
        `AI: ${task.providerLabel} | ${task.model || "auto"}`,
        Array.isArray(task.providersUsed) && task.providersUsed.length ? `Providers used:\n- ${task.providersUsed.join("\n- ")}` : null,
        `Output folder: ${task.outputDir}`,
        "",
        truncateForTelegram(task.summary)
      ].filter(Boolean).join("\n"),
      replyMarkupForCommand("tasks")
    );

    const shareFiles = task.outputs.filter((filePath) => filePath.endsWith(".pdf") || filePath.endsWith(".zip")).slice(0, 2);
    for (const filePath of shareFiles) {
      await sendTelegramDocument(token, task.chatId, filePath, `Task ${task.shortId} output: ${path.basename(filePath)}`).catch(() => {});
    }
  } catch (error) {
    const task = await updateAgentTask(taskId, (current) => ({
      ...current,
      status: "failed",
      completedAt: nowIso(),
      updatedAt: nowIso(),
      error: userFacingErrorMessage(error)
    })).catch(() => null);

    if (task) {
      await sendTelegramText(token, task.chatId, `Agent task ${task.shortId} failed.\n\n${task.error}`, replyMarkupForCommand("tasks")).catch(() => {});
    }
  } finally {
    ACTIVE_AGENT_TASKS.delete(taskId);
  }
}

async function startAgentTask(bot, token, chatId, type, target, objective) {
  const task = await createAgentTaskRecord(bot, chatId, type, target, objective);
  runAgentTaskInBackground(bot, token, task.id).catch(() => {});
  return [
    `Queued ${type} agent task.`,
    `ID: ${task.shortId}`,
    `Target: ${task.target || "prompt only"}`,
    `AI: ${task.providerLabel} | ${task.model || "auto"}`,
    "",
    "I will follow up here in Telegram when the work pack is ready."
  ].join("\n");
}

async function startDelegatedTask(bot, token, chatId, providerToken, type, target, objective, modelName = "") {
  const task = await createAgentTaskRecordWithSelection(bot, chatId, type, target, objective, providerToken, modelName);
  runAgentTaskInBackground(bot, token, task.id).catch(() => {});
  return [
    `Queued delegated ${type} task.`,
    `ID: ${task.shortId}`,
    `Target: ${task.target || "prompt only"}`,
    `AI: ${task.providerLabel} | ${task.model || "auto"}`,
    "",
    "I will supervise the task and report back here when it finishes."
  ].join("\n");
}

async function startAutopilotTask(bot, token, chatId, type, target, objective) {
  const [profile] = recommendedProfiles(bot, type, 1);
  if (!profile) {
    throw new Error("No configured AI providers are available for autopilot.");
  }
  return startDelegatedTask(bot, token, chatId, profile.id, type, target, objective);
}

async function startSquadTask(bot, token, chatId, type, target, objective) {
  const task = await createSquadTaskRecord(bot, chatId, type, target, objective);
  runAgentTaskInBackground(bot, token, task.id).catch(() => {});
  return [
    `Queued squad ${type} task.`,
    `ID: ${task.shortId}`,
    `Target: ${task.target || "prompt only"}`,
    `Supervisor: Ollama local | ${task.model}`,
    `Recommended squad: ${recommendedProfiles(bot, type, 3).map((profile) => profile.label).join(", ")}`,
    "",
    "I will run multiple agents, synthesize the result locally, and follow up here with the final pack."
  ].join("\n");
}

function parseAgentTaskArgs(args, expectedType = "") {
  const parts = String(args || "").split("|").map((value) => value.trim());
  if (expectedType) {
    const target = parts[0] || "";
    const objective = parts.slice(1).join(" | ").trim();
    if (!target) {
      throw new Error(`Use /${expectedType}agent target | objective`);
    }
    return { type: expectedType, target, objective };
  }

  const [type, target, ...rest] = parts;
  const objective = rest.join(" | ").trim();
  if (!type || !target) {
    throw new Error("Use /agenttask doc|sheet|site|general | target | objective");
  }
  const normalizedType = type.toLowerCase();
  if (!["doc", "sheet", "site", "general"].includes(normalizedType)) {
    throw new Error("Supported agent types: doc, sheet, site, general");
  }
  return { type: normalizedType, target, objective };
}

function parseDelegateArgs(args) {
  const [rawProvider, rawType, rawTarget, ...rest] = String(args || "").split("|").map((value) => value.trim());
  if (!rawProvider || !rawType || !rawTarget) {
    throw new Error("Use /delegate provider | doc|sheet|site|general | target | objective");
  }
  const type = rawType.toLowerCase();
  if (!["doc", "sheet", "site", "general"].includes(type)) {
    throw new Error("Supported delegate task types: doc, sheet, site, general");
  }
  return {
    providerToken: rawProvider,
    type,
    target: rawTarget,
    objective: rest.join(" | ").trim()
  };
}

async function listAgentTasks(bot, chatId) {
  const tasks = (await readAgentTasks())
    .filter((task) => task.botId === bot.id && String(task.chatId) === String(chatId))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  if (!tasks.length) {
    return "No agent tasks yet.\n\nUse /docagent, /sheetagent, /siteagent, or /agenttask.";
  }
  return truncateForTelegram(["Recent agent tasks", "", ...tasks.slice(0, 10).map((task) => describeAgentTask(task))].join("\n\n"));
}

async function resolveAgentTask(bot, chatId, idArg) {
  const token = String(idArg || "").trim().replace(/^#/, "");
  if (!token) {
    throw new Error("A task id is required.");
  }
  const tasks = await readAgentTasks();
  const task = tasks.find((entry) => entry.botId === bot.id && String(entry.chatId) === String(chatId) && (entry.shortId === token || entry.id === token));
  if (!task) {
    throw new Error(`Could not find task ${token}`);
  }
  return task;
}

async function agentTaskStatus(bot, chatId, idArg) {
  const task = await resolveAgentTask(bot, chatId, idArg);
  return truncateForTelegram(describeAgentTask(task));
}

async function resendAgentTaskOutputs(bot, token, chatId, idArg) {
  const task = await resolveAgentTask(bot, chatId, idArg);
  if (!Array.isArray(task.outputs) || !task.outputs.length) {
    throw new Error("That task has no saved outputs yet.");
  }
  const shareFiles = task.outputs.filter((filePath) => fs.existsSync(filePath) && (filePath.endsWith(".pdf") || filePath.endsWith(".zip"))).slice(0, 2);
  for (const filePath of shareFiles) {
    await sendTelegramDocument(token, chatId, filePath, `Task ${task.shortId} output: ${path.basename(filePath)}`);
  }
  return `Re-sent ${shareFiles.length || 0} file outputs for task ${task.shortId}.`;
}

function agentHelpText() {
  return [
    "Agent tasks",
    "",
    "/providers",
    "/provider openai:project1",
    "/provider anthropic",
    "/provider openrouter",
    "/models",
    "/model gpt-5-mini",
    "/modeluse cohere | command-r7b-12-2024",
    "/docagent desktop\\file.txt | build a detailed brief and plan",
    "/sheetagent desktop\\sheet.xlsx | summarize this data and produce actions",
    "/siteagent wix | audit the site and build a roadmap",
    "/agenttask general | desktop\\notes.txt | turn this into an execution pack",
    "/supervisor doc | desktop\\file.txt | run a managed work pack",
    "/autopilot doc | desktop\\file.txt | choose the best provider automatically",
    "/squad doc | desktop\\file.txt | run multiple providers and synthesize the result",
    "/delegate anthropic | doc | desktop\\file.txt | use Claude on this",
    "/tasks",
    "/taskstatus id",
    "/tasksend id"
  ].join("\n");
}

async function ideasCommand(bot, prompt) {
  const text = await askModel(
    bot,
    `Give me a concise but creative set of build ideas for this request:\n\n${prompt || "new product ideas"}`,
    "You are a sharp product and creative engineering partner. Respond with a short list of bold, practical build ideas."
  );
  return truncateForTelegram(text);
}

async function planBuildCommand(bot, prompt) {
  const text = await askModel(
    bot,
    `Create a strong implementation plan for this build request:\n\n${prompt || "new product feature"}`,
    "You are a senior engineer. Return a concise implementation plan with architecture, files to touch, risks, and a recommended build sequence."
  );
  return truncateForTelegram(text);
}

function helpText(bot) {
  return [
    `Connected to ${bot.name}${bot.username ? ` (@${bot.username})` : ""}`,
    "",
    "You can talk normally now, not just with commands.",
    "",
    "/start - show this help",
    "/dashboard - open the grouped control dashboard",
    "/menu - show the quick action menu again",
    "/workbench - open the build-focused tool panel",
    "/mode read|build - switch natural-language behavior",
    "/status - show current laptop bot status",
    "/health - show connection and runner health",
    "/roots - list allowed roots",
    "/files [path] - list files",
    "/tree [path] - show a file tree",
    "/project - summarize the current workspace",
    "/fileinfo path - show file details",
    "/read path - read a text file",
    "/viewdoc path - preview a document file",
    "/newdoc title | optional content - create a markdown document on Desktop",
    "/draft title | optional content - create a fast working draft on Desktop",
    "/docs [path] - list recent documents and work folders",
    "/workon path | objective - send a document into autopilot",
    "/write path | content - write a file",
    "/append path | content - append to a file",
    "/mkdir path - create a directory",
    "/copy source | target - copy a file or folder",
    "/move source | target - move a file or folder",
    "/run command - run a PowerShell command in the primary root",
    "/ask prompt - send a prompt to Ollama",
    "/ideas prompt - brainstorm things to build",
    "/outline prompt - create a stronger execution outline",
    "/planbuild prompt - create a build plan",
    "/intake name-or-path | objective - start capturing long text into a desktop file",
    "/capturedone - finish intake and generate plan files",
    "/capturecancel - cancel the active intake session",
    "/analyze path | objective - generate a full case room from a saved file",
    "/summarize path | objective - summarize a file into key points and actions",
    "/casepack path | objective - same as /analyze but named for case work",
    "/html path | prompt - generate a polished HTML app",
    "/component path | prompt - generate a React component",
    "/route path | prompt - generate a Next.js route",
    "/spec path | prompt - generate a markdown spec",
    "/replace path | old | new - targeted file replacement",
    "/zip path - archive a file or folder",
    "/find pattern | optional path - find files by name",
    "/grep text | optional path - search file contents",
    "/gitstatus - show repo status",
    "/gitlog - show recent commits",
    "/sysinfo - show local system info",
    "/network - show local network overview",
    "/wifi - show current Wi-Fi details",
    "/ping host - test a host",
    "/ports host - test common ports",
    "/devices - list known devices",
    "/devicescan - quick scan of the local subnet",
    "/deviceadd name | ip | notes - save a device profile",
    "/devicedetail name-or-id - show a saved device",
    "/deviceping name-or-ip - ping a saved device",
    "/deviceports name-or-ip - scan common ports on a device",
    "/wix - show Wix summary",
    "/wixcontacts - show recent Wix contacts",
    "/notionstatus - check Notion integration health",
    "/notionsearch query - search accessible Notion content",
    "/notionopen page title - open the best matching page without an ID",
    "/notionpage page_id - read a page preview",
    "/notionappend page_id | text - append text to a page",
    "/notionappendto page title | text - append to the best matching page",
    "/notioncreate parent_page_id | Title | content - create a page",
    "/notioncreatein parent title | New Title | content - create under the best matching parent page",
    "/notionquery data_source_id - query a data source",
    "/notionusers - list accessible Notion users",
    "/manus prompt - run a low-cost Manus task",
    "/manusnotion prompt - run a low-cost Manus task with the Notion connector",
    "/manusstatus task_id - check a Manus task",
    "/manuslist - list recent Manus tasks",
    "/fetch url - fetch a public webpage",
    "/providers - list configured AI providers",
    "/provider name - switch the active provider profile",
    "/models [provider] - list models for the current or selected provider",
    "/model name - change the active model on the current provider",
    "/modeluse provider | model - switch provider and model together",
    "/capabilities - show the current AI/tools capability map",
    "/agenthelp - show the background agent task workflow",
    "/docagent path | objective - run a document agent in the background",
    "/sheetagent path | objective - run a spreadsheet agent in the background",
    "/siteagent wix|url|path | objective - run a site/app agent in the background",
    "/agenttask type | target | objective - queue a general background task",
    "/supervisor type | target | objective - queue a managed work pack on the current AI selection",
    "/autopilot type | target | objective - automatically choose the best provider for a task",
    "/squad type | target | objective - run multiple providers and merge the result",
    "/delegate provider | type | target | objective - send a task to a specific provider",
    "/tasks - list agent tasks for this chat",
    "/taskstatus id - inspect one agent task",
    "/tasksend id - resend the main task output files",
    "/schedulehelp - show schedule examples",
    "/scheduleadd when | task - create a schedule",
    "/schedules - list schedules for this chat",
    "/scheduledelete id - remove a schedule",
    "/clear - clear chat memory"
  ].join("\n");
}

function telegramCommandList() {
  return [
    { command: "start", description: "Open the main help and controls" },
    { command: "dashboard", description: "Open the grouped control dashboard" },
    { command: "workbench", description: "Open the build tool panel" },
    { command: "mode", description: "Switch read/build behavior" },
    { command: "menu", description: "Show the quick action menu" },
    { command: "status", description: "Show bot and workspace status" },
    { command: "health", description: "Check runner, Wi-Fi, internet, and Ollama" },
    { command: "files", description: "List files in a folder" },
    { command: "docs", description: "List recent documents and work folders" },
    { command: "newdoc", description: "Create a markdown document on Desktop" },
    { command: "draft", description: "Create a quick working draft document" },
    { command: "workon", description: "Send a document into autopilot" },
    { command: "tree", description: "Show a file tree" },
    { command: "project", description: "Summarize the current project" },
    { command: "fileinfo", description: "Show file details" },
    { command: "gitstatus", description: "Show git status" },
    { command: "network", description: "Show local network overview" },
    { command: "devices", description: "List saved and scanned devices" },
    { command: "devicescan", description: "Quick scan the local subnet" },
    { command: "wifi", description: "Show current Wi-Fi details" },
    { command: "ideas", description: "Brainstorm things to build" },
    { command: "outline", description: "Create a strong execution outline" },
    { command: "planbuild", description: "Create a build plan" },
    { command: "summarize", description: "Summarize a file into main points" },
    { command: "intake", description: "Capture long text into a file" },
    { command: "capturedone", description: "Finish intake and generate a case room" },
    { command: "casepack", description: "Generate a case room from a file" },
    { command: "wix", description: "Show Wix site summary" },
    { command: "notionstatus", description: "Check Notion connection" },
    { command: "notionsearch", description: "Search accessible Notion content" },
    { command: "manus", description: "Start a low-cost Manus task" },
    { command: "manuslist", description: "List recent Manus tasks" },
    { command: "providers", description: "List configured AI providers" },
    { command: "provider", description: "Switch the active AI provider" },
    { command: "models", description: "List models for the active provider" },
    { command: "modeluse", description: "Switch provider and model together" },
    { command: "capabilities", description: "Show the bot capability map" },
    { command: "docagent", description: "Queue a background document agent" },
    { command: "sheetagent", description: "Queue a background spreadsheet agent" },
    { command: "siteagent", description: "Queue a background site agent" },
    { command: "supervisor", description: "Queue a managed work pack" },
    { command: "autopilot", description: "Auto-pick the best provider for a task" },
    { command: "squad", description: "Run a multi-provider squad synthesis" },
    { command: "delegate", description: "Send work to a specific AI provider" },
    { command: "tasks", description: "List background agent tasks" },
    { command: "schedulehelp", description: "Show schedule examples" },
    { command: "schedules", description: "List saved schedules" },
    { command: "clear", description: "Clear the current chat memory" }
  ];
}

function chatStatePath(botId, chatId) {
  return path.join(CHAT_DIR, `${botId}-${chatId}.json`);
}

async function readChatState(botId, chatId) {
  const target = chatStatePath(botId, chatId);
  try {
    const raw = await fsp.readFile(target, "utf8");
    const parsed = JSON.parse(raw);
    return {
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      mode: parsed.mode === "build" ? "build" : "read",
      capture: parsed.capture || null
    };
  } catch {
    return { messages: [], mode: "read", capture: null };
  }
}

async function writeChatState(botId, chatId, state) {
  await fsp.mkdir(CHAT_DIR, { recursive: true });
  await fsp.writeFile(chatStatePath(botId, chatId), JSON.stringify(state, null, 2), "utf8");
}

async function clearChatState(botId, chatId) {
  try {
    await fsp.unlink(chatStatePath(botId, chatId));
  } catch {}
}

function pushChatMessage(state, role, content) {
  const next = [...(state.messages || []), { role, content, at: new Date().toISOString() }];
  return {
    messages: next.slice(-MAX_HISTORY_MESSAGES),
    mode: currentChatMode(state),
    capture: state.capture || null
  };
}

function extractJsonObject(text) {
  const source = String(text || "");
  const match = source.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error("No JSON object found in model response.");
  }
  return JSON.parse(match[0]);
}

async function executeToolAction(bot, action, roots, state) {
  const tool = String(action.tool || "").toLowerCase();

  if (tool === "reply") {
    return { tool, result: String(action.message || "") };
  }
  if (tool === "status") {
    return {
      tool,
      result: [
        `${bot.name} is online.`,
        `Primary root: ${roots[0]}`,
        `Allowed roots: ${roots.length}`,
        `AI selection: ${selectionSummary(bot)}`
      ].join("\n")
    };
  }
  if (tool === "list_roots") {
    return { tool, result: roots.map((root) => `- ${root}`).join("\n") };
  }
  if (tool === "list_files") {
    return { tool, result: await listFiles(action.path || "", roots) };
  }
  if (tool === "tree_files") {
    return { tool, result: await treeFiles(action.path || "", roots) };
  }
  if (tool === "find_files") {
    return { tool, result: await findFiles(`${action.pattern || ""} | ${action.path || ""}`, roots) };
  }
  if (tool === "grep_files") {
    return { tool, result: await grepFiles(`${action.pattern || ""} | ${action.path || ""}`, roots) };
  }
  if (tool === "read_file") {
    return { tool, result: await readFileCommand(action.path || "", roots) };
  }
  if (tool === "write_file") {
    if (currentChatMode(state) !== "build") {
      throw new Error("write_file is only available in build mode.");
    }
    return { tool, result: await writeFileCommand(`${action.path || ""} | ${String(action.content || "")}`, roots, false) };
  }
  if (tool === "append_file") {
    if (currentChatMode(state) !== "build") {
      throw new Error("append_file is only available in build mode.");
    }
    return { tool, result: await writeFileCommand(`${action.path || ""} | ${String(action.content || "")}`, roots, true) };
  }
  if (tool === "make_dir") {
    if (currentChatMode(state) !== "build") {
      throw new Error("make_dir is only available in build mode.");
    }
    return { tool, result: await mkdirCommand(action.path || "", roots) };
  }
  if (tool === "replace_in_file") {
    if (currentChatMode(state) !== "build") {
      throw new Error("replace_in_file is only available in build mode.");
    }
    return { tool, result: await replaceInFileCommand(`${action.path || ""} | ${String(action.old_text || action.oldText || "")} | ${String(action.new_text || action.newText || "")}`, roots) };
  }
  if (tool === "run_command") {
    if (currentChatMode(state) !== "build") {
      throw new Error("run_command is only available in build mode.");
    }
    return { tool, result: await runCommand(String(action.command || ""), roots) };
  }
  if (tool === "file_info") {
    return { tool, result: await fileInfoCommand(action.path || "", roots) };
  }
  if (tool === "git_status") {
    return { tool, result: await gitStatus(roots) };
  }
  if (tool === "git_log") {
    return { tool, result: await gitLog(roots) };
  }
  if (tool === "project_overview") {
    return { tool, result: await projectOverview(roots) };
  }
  if (tool === "system_info") {
    return { tool, result: await systemInfo(bot, roots) };
  }
  if (tool === "health_summary") {
    return { tool, result: await healthSummary(bot, roots) };
  }
  if (tool === "network_overview") {
    return { tool, result: await networkOverview() };
  }
  if (tool === "devices_list") {
    return { tool, result: await listDevices() };
  }
  if (tool === "devices_scan") {
    return { tool, result: await scanNetworkDevices() };
  }
  if (tool === "wifi_info") {
    return { tool, result: await currentWifiInfo() };
  }
  if (tool === "ping_host") {
    return { tool, result: await pingHost(action.host || "") };
  }
  if (tool === "scan_ports") {
    return { tool, result: await scanCommonPorts(action.host || "") };
  }
  if (tool === "wix_summary") {
    return { tool, result: await wixSummary() };
  }
  if (tool === "wix_contacts") {
    return { tool, result: await wixContacts() };
  }
  if (tool === "notion_status") {
    return { tool, result: await notionStatus() };
  }
  if (tool === "notion_search") {
    return { tool, result: await notionSearchCommand(action.query || "") };
  }
  if (tool === "notion_page") {
    return { tool, result: await notionPageCommand(action.page_id || action.pageId || "") };
  }
  if (tool === "fetch_url") {
    return { tool, result: await fetchWebPage(action.url || "") };
  }
  if (tool === "ask_model") {
    return { tool, result: truncateForTelegram(await askModel(bot, String(action.prompt || ""))) };
  }

  throw new Error(`Unsupported tool: ${tool}`);
}

function buildPlannerPrompt(bot, roots, state, userText) {
  const history = (state.messages || [])
    .slice(-6)
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n");
  const mode = currentChatMode(state);
  const buildTools = mode === "build"
    ? [
        "- write_file with path and content",
        "- append_file with path and content",
        "- make_dir with path",
        "- replace_in_file with path, old_text, new_text",
        "- run_command with command"
      ]
    : [];
  const modeRules = mode === "build"
    ? [
        "- Build mode is enabled. You may create files, folders, replacements, and safe commands when clearly useful.",
        "- Prefer concrete implementation steps over generic advice when the user asks you to build something.",
        "- Keep commands safe and inside the allowed roots."
      ]
    : [
        "- This planner is read-only by default. Do not write files, create folders, or run arbitrary commands.",
        "- For risky or state-changing requests, reply with guidance instead of taking action."
      ];

  return [
    "You are a Telegram laptop assistant with access to local tools.",
    bot.systemPrompt || "",
    `Current mode: ${mode}`,
    `Current AI selection: ${selectionSummary(bot)}`,
    "",
    "Allowed roots:",
    ...roots.map((root) => `- ${root}`),
    "",
    "Available tools:",
    "- reply: respond normally without using tools",
    "- status",
    "- list_roots",
    "- list_files with optional path",
    "- tree_files with optional path",
    "- find_files with pattern and optional path",
    "- grep_files with pattern and optional path",
    "- read_file with path",
    "- file_info with path",
    "- git_status",
    "- git_log",
    "- project_overview",
    "- system_info",
    "- health_summary",
    "- network_overview",
    "- devices_list",
    "- devices_scan",
    "- wifi_info",
    "- ping_host with host",
    "- scan_ports with host",
    "- wix_summary",
    "- wix_contacts",
    "- notion_status",
    "- notion_search with query",
    "- notion_page with page_id",
    "- fetch_url with url",
    "- ask_model with prompt",
    ...buildTools,
    "",
    "Rules:",
    "- Return only valid JSON.",
    "- Use at most 3 tool actions.",
    "- Prefer a normal reply when the user is chatting casually.",
    "- You know the slash commands, models, providers, and task workflows available in this bot. If the user asks how to do something, suggest the most relevant command or agent path.",
    "- qwen2.5-coder on local Ollama is the default supervisor model unless the user explicitly wants another provider or model.",
    "- For document workflows, remember the simpler commands: /newdoc, /docs, /viewdoc, /workon, /autopilot, /squad.",
    "- Only use file tools for paths inside allowed roots.",
    ...modeRules,
    "- If the request is unsafe or unclear, reply instead of taking actions.",
    "",
    "JSON schema:",
    '{"mode":"reply"|"act","reply":"string","actions":[{"tool":"tool_name","path":"optional","content":"optional","command":"optional","prompt":"optional","message":"optional"}]}',
    "",
    history ? `Recent conversation:\n${history}\n` : "Recent conversation:\n(none)\n",
    `Latest user message:\n${userText}`
  ].join("\n");
}

function buildFinalResponsePrompt(bot, state, userText, toolResults) {
  const history = (state.messages || [])
    .slice(-6)
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n");

  const tools = toolResults
    .map((result, index) => `TOOL ${index + 1} (${result.tool})\n${result.result}`)
    .join("\n\n");

  return [
    "You are a concise Telegram assistant replying to the user after tool execution.",
    bot.systemPrompt || "",
    "",
    history ? `Recent conversation:\n${history}\n` : "Recent conversation:\n(none)\n",
    `User message:\n${userText}\n`,
    `Tool results:\n${tools}\n`,
    "Write a short natural-language reply for Telegram.",
    "Mention what you did, any important output, and any next step if needed."
  ].join("\n");
}

async function handleDirectChat(bot, userText, state) {
  const history = (state.messages || [])
    .slice(-6)
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n");
  const profile = fastChatProfile(bot);
  const prompt = [
    history ? `Recent conversation:\n${history}\n` : "Recent conversation:\n(none)\n",
    `User message:\n${userText}\n`,
    "Reply naturally for Telegram.",
    "Be concise, friendly, and useful.",
    "If the user seems to want action, mention the most relevant command or task flow briefly."
  ].join("\n");

  const reply = await askModel(
    bot,
    prompt,
    "You are a responsive Telegram assistant. Keep replies short, clear, and helpful.",
    profile ? { profileId: profile.id } : undefined
  );
  return truncateForTelegram(reply);
}

async function handleNaturalLanguage(bot, userText, roots, state) {
  if (!shouldUsePlanner(userText)) {
    return handleDirectChat(bot, userText, state);
  }

  const plannerPrompt = buildPlannerPrompt(bot, roots, state, userText);
  const plannerProfile = fastChatProfile(bot);
  const plannerResponse = await askModel(
    bot,
    plannerPrompt,
    "You are a strict JSON planner. Return JSON only with no markdown fences.",
    plannerProfile ? { profileId: plannerProfile.id } : undefined
  );

  let plan;
  try {
    plan = extractJsonObject(plannerResponse);
  } catch {
    return truncateForTelegram(plannerResponse);
  }

  if (plan.mode !== "act" || !Array.isArray(plan.actions) || !plan.actions.length) {
    return truncateForTelegram(String(plan.reply || plannerResponse));
  }

  const toolResults = [];
  for (const action of plan.actions.slice(0, MAX_TOOL_ACTIONS)) {
    try {
      toolResults.push(await executeToolAction(bot, action, roots, state));
    } catch (error) {
      toolResults.push({
        tool: String(action.tool || "unknown"),
        result: `Error: ${error.message || String(error)}`
      });
    }
  }

  const finalResponse = await askModel(
    bot,
    buildFinalResponsePrompt(bot, state, userText, toolResults),
    "You are a concise Telegram assistant. No markdown tables. Keep replies short and useful.",
    plannerProfile ? { profileId: plannerProfile.id } : undefined
  );

  return truncateForTelegram(finalResponse);
}

async function updateBotAiSettings(botId, updates) {
  const bots = await readBots();
  const index = bots.findIndex((bot) => bot.id === botId);
  if (index < 0) {
    throw new Error("Bot not found.");
  }
  bots[index] = {
    ...bots[index],
    ...updates
  };
  if (updates.modelName) {
    bots[index].modelName = updates.modelName;
  }
  if (updates.aiProviderId) {
    const [provider, profile] = String(updates.aiProviderId).split(":");
    bots[index].modelProvider = provider;
    bots[index].providerProfile = profile || "";
  }
  if (updates.modelName && (updates.aiProviderId || "").startsWith("ollama:")) {
    bots[index].ollamaModel = updates.modelName;
  }
  bots[index].updatedAt = new Date().toISOString();
  await fsp.writeFile(BOTS_FILE, JSON.stringify({ bots }, null, 2), "utf8");
  return bots[index];
}

async function addSchedule(bot, chatId, rawSpec) {
  const parsed = parseScheduleSpec(rawSpec);
  const schedules = await readSchedules();
  const schedule = {
    id: makeId("schedule"),
    shortId: makeId("job").split("-")[1],
    botId: bot.id,
    chatId: String(chatId),
    label: parsed.label,
    cadence: parsed.cadence,
    intervalMinutes: parsed.intervalMinutes || null,
    hour: Number.isFinite(parsed.hour) ? parsed.hour : null,
    minute: Number.isFinite(parsed.minute) ? parsed.minute : null,
    payload: parsed.payload,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    lastRunAt: null,
    nextRunAt: computeNextRun(parsed)
  };
  schedules.push(schedule);
  await writeSchedules(schedules);
  return `Scheduled ${schedule.label}\n\n${describeSchedule(schedule)}`;
}

async function listSchedules(bot, chatId) {
  const schedules = (await readSchedules()).filter((schedule) => schedule.botId === bot.id && String(schedule.chatId) === String(chatId));
  if (!schedules.length) {
    return "No schedules yet.\n\nUse /scheduleadd every 30m | /health";
  }
  return truncateForTelegram([
    "Saved schedules",
    "",
    ...schedules.map((schedule) => describeSchedule(schedule))
  ].join("\n\n"));
}

async function deleteSchedule(bot, chatId, idArg) {
  const shortId = String(idArg || "").trim().replace(/^#/, "");
  if (!shortId) {
    throw new Error("Use /scheduledelete schedule-id");
  }
  const schedules = await readSchedules();
  const remaining = schedules.filter((schedule) => !(schedule.botId === bot.id && String(schedule.chatId) === String(chatId) && (schedule.shortId === shortId || schedule.id === shortId)));
  if (remaining.length === schedules.length) {
    throw new Error(`Could not find schedule ${shortId}`);
  }
  await writeSchedules(remaining);
  return `Deleted schedule ${shortId}`;
}

function scheduleHelpText() {
  return [
    "Scheduling",
    "",
    "/scheduleadd every 30m | /health",
    "/scheduleadd daily 09:00 | /project",
    "/scheduleadd daily 18:30 | summarize today's repo status",
    "/schedules",
    "/scheduledelete id"
  ].join("\n");
}

async function runScheduledPayload(bot, token, schedule) {
  const chatId = schedule.chatId;
  const roots = getAllowedRoots(bot);
  let state = await readChatState(bot.id, chatId);
  let reply = "";
  let extra = {};

  if (String(schedule.payload || "").trim().startsWith("/")) {
    const { command, args } = splitCommand(schedule.payload);
    const response = await executeTelegramCommand(bot, token, command, args, roots, chatId);
    reply = response.text;
    extra = response.extra || {};
    if (response.state) {
      state = response.state;
    }
  } else {
    state = pushChatMessage(state, "user", `[scheduled] ${schedule.payload}`);
    reply = await handleNaturalLanguage(bot, schedule.payload, roots, state);
    extra = replyMarkupForCommand("menu");
  }

  const prefix = `Scheduled task ${schedule.shortId} (${schedule.label})`;
  await sendTelegramText(token, chatId, `${prefix}\n\n${reply}`, extra);
  state = pushChatMessage(state, "assistant", `[scheduled] ${reply}`);
  await writeChatState(bot.id, chatId, state);
}

async function processSchedules(bot, token) {
  const schedules = await readSchedules();
  const now = new Date();
  let changed = false;

  for (const schedule of schedules) {
    if (schedule.botId !== bot.id || !schedule.nextRunAt) {
      continue;
    }

    if (new Date(schedule.nextRunAt).getTime() > now.getTime()) {
      continue;
    }

    try {
      await runScheduledPayload(bot, token, schedule);
      schedule.lastRunAt = nowIso();
    } catch (error) {
      await sendTelegramText(token, schedule.chatId, `Scheduled task ${schedule.shortId} failed: ${error.message || String(error)}`).catch(() => {});
      schedule.lastRunAt = nowIso();
    }

    schedule.nextRunAt = computeNextRun(schedule, new Date(now.getTime() + 1000));
    schedule.updatedAt = nowIso();
    changed = true;
  }

  if (changed) {
    await writeSchedules(schedules);
  }
}

async function executeTelegramCommand(bot, token, command, args, roots, chatId) {
  let state = await readChatState(bot.id, chatId);

  if (command === "start" || command === "help") {
    return { text: helpText(bot), extra: { reply_markup: commandKeyboard() } };
  }
  if (command === "menu" || command === "dashboard") {
    return { text: dashboardText(bot), extra: { reply_markup: dashboardInlineKeyboard() } };
  }
  if (command === "workbench") {
    return { text: `Build workbench\nCurrent mode: ${currentChatMode(state)}`, extra: { reply_markup: buildInlineKeyboard() } };
  }
  if (command === "mode") {
    const nextMode = String(args || "").trim().toLowerCase();
    if (nextMode !== "read" && nextMode !== "build") {
      throw new Error("Use /mode read or /mode build");
    }
    state = withChatMode(state, nextMode);
    return { text: `Mode changed to ${nextMode}.`, extra: replyMarkupForCommand("workbench"), state };
  }
  if (command === "status") {
    return {
      text: [
        `${bot.name} is online.`,
        `Primary root: ${roots[0]}`,
        `Allowed roots: ${roots.length}`,
        `AI selection: ${selectionSummary(bot)}`,
        `Ollama base: ${bot.ollamaBaseUrl || "not set"}`,
        `Mode: ${currentChatMode(state)}`
      ].join("\n"),
      extra: replyMarkupForCommand(command)
    };
  }
  if (command === "health") {
    return { text: await healthSummary(bot, roots), extra: replyMarkupForCommand(command) };
  }
  if (command === "roots") {
    return {
      text: [`Allowed roots for ${bot.name}:`, "", ...roots.map((root) => `- ${root}`)].join("\n"),
      extra: replyMarkupForCommand(command)
    };
  }
  if (command === "files") {
    return { text: await listFiles(args, roots), extra: replyMarkupForCommand(command) };
  }
  if (command === "docs") {
    return { text: await listRecentDocuments(roots, args), extra: replyMarkupForCommand(command) };
  }
  if (command === "tree") {
    return { text: await treeFiles(args, roots), extra: replyMarkupForCommand(command) };
  }
  if (command === "project") {
    return { text: await projectOverview(roots), extra: replyMarkupForCommand(command) };
  }
  if (command === "find") {
    return { text: await findFiles(args, roots), extra: replyMarkupForCommand(command) };
  }
  if (command === "grep") {
    return { text: await grepFiles(args, roots), extra: replyMarkupForCommand(command) };
  }
  if (command === "read") {
    return { text: await readFileCommand(args, roots), extra: replyMarkupForCommand(command) };
  }
  if (command === "viewdoc") {
    return { text: await readFileCommand(args, roots), extra: replyMarkupForCommand(command) };
  }
  if (command === "fileinfo") {
    return { text: await fileInfoCommand(args, roots), extra: replyMarkupForCommand(command) };
  }
  if (command === "newdoc") {
    return { text: await createDocumentCommand(args, roots), extra: replyMarkupForCommand(command) };
  }
  if (command === "quickdoc" || command === "draft") {
    return { text: await createDocumentCommand(args, roots), extra: replyMarkupForCommand("newdoc") };
  }
  if (command === "workon") {
    return { text: await workOnDocumentCommand(bot, token, chatId, roots, args), extra: replyMarkupForCommand("tasks") };
  }
  if (command === "write") {
    return { text: await writeFileCommand(args, roots, false), extra: replyMarkupForCommand(command) };
  }
  if (command === "append") {
    return { text: await writeFileCommand(args, roots, true), extra: replyMarkupForCommand(command) };
  }
  if (command === "mkdir") {
    return { text: await mkdirCommand(args, roots), extra: replyMarkupForCommand(command) };
  }
  if (command === "copy") {
    return { text: await copyCommand(args, roots), extra: replyMarkupForCommand(command) };
  }
  if (command === "move") {
    return { text: await moveCommand(args, roots), extra: replyMarkupForCommand(command) };
  }
  if (command === "run" || command === "build") {
    return {
      text: await runCommand(command === "build" && !args ? "npm run build" : args || "npm run build", roots),
      extra: replyMarkupForCommand(command)
    };
  }
  if (command === "ask") {
    return { text: truncateForTelegram(await askModel(bot, args)), extra: replyMarkupForCommand(command) };
  }
  if (command === "ideas") {
    return { text: await ideasCommand(bot, args), extra: replyMarkupForCommand("workbench") };
  }
  if (command === "brainstorm") {
    return { text: await ideasCommand(bot, args), extra: replyMarkupForCommand("workbench") };
  }
  if (command === "planbuild") {
    return { text: await planBuildCommand(bot, args), extra: replyMarkupForCommand("workbench") };
  }
  if (command === "outline") {
    return { text: await planBuildCommand(bot, args), extra: replyMarkupForCommand("workbench") };
  }
  if (command === "intake") {
    const intake = await startIntakeSession(args, roots);
    state = {
      ...state,
      capture: intake.capture,
      mode: currentChatMode(state)
    };
    return { text: intake.message, extra: replyMarkupForCommand("workbench"), state };
  }
  if (command === "capturedone") {
    const finished = await finishCaptureSession(bot, roots, state);
    return { text: finished.message, extra: replyMarkupForCommand("workbench"), state: finished.state };
  }
  if (command === "capturecancel") {
    state = await cancelCaptureSession(state);
    return { text: "Intake session cancelled.", extra: replyMarkupForCommand("workbench"), state };
  }
  if (command === "analyze") {
    return { text: await analyzeFileCommand(bot, roots, args), extra: replyMarkupForCommand("workbench") };
  }
  if (command === "summarize") {
    return { text: await analyzeFileCommand(bot, roots, args), extra: replyMarkupForCommand("workbench") };
  }
  if (command === "casepack") {
    return { text: await analyzeFileCommand(bot, roots, args), extra: replyMarkupForCommand("workbench") };
  }
  if (command === "html") {
    return {
      text: await writeGeneratedArtifact(
        bot,
        roots,
        args,
        "Return only a complete HTML document with inline CSS and JS. No markdown fences.",
        "html"
      ),
      extra: replyMarkupForCommand("workbench")
    };
  }
  if (command === "component") {
    return {
      text: await writeGeneratedArtifact(
        bot,
        roots,
        args,
        "Return only a React TSX component file. No markdown fences. Keep it production-ready.",
        "component"
      ),
      extra: replyMarkupForCommand("workbench")
    };
  }
  if (command === "route") {
    return {
      text: await writeGeneratedArtifact(
        bot,
        roots,
        args,
        "Return only a Next.js route handler in TypeScript. No markdown fences.",
        "route"
      ),
      extra: replyMarkupForCommand("workbench")
    };
  }
  if (command === "spec") {
    return {
      text: await writeGeneratedArtifact(
        bot,
        roots,
        args,
        "Return only markdown. Write a concise but strong project specification.",
        "spec"
      ),
      extra: replyMarkupForCommand("workbench")
    };
  }
  if (command === "replace") {
    return { text: await replaceInFileCommand(args, roots), extra: replyMarkupForCommand("workbench") };
  }
  if (command === "zip") {
    return { text: await zipPathCommand(args, roots), extra: replyMarkupForCommand("workbench") };
  }
  if (command === "gitstatus") {
    return { text: await gitStatus(roots), extra: replyMarkupForCommand(command) };
  }
  if (command === "gitlog") {
    return { text: await gitLog(roots), extra: replyMarkupForCommand(command) };
  }
  if (command === "sysinfo") {
    return { text: await systemInfo(bot, roots), extra: replyMarkupForCommand(command) };
  }
  if (command === "network") {
    return { text: await networkOverview(), extra: replyMarkupForCommand(command) };
  }
  if (command === "devices") {
    return { text: await listDevices(), extra: replyMarkupForCommand(command) };
  }
  if (command === "devicescan") {
    return { text: await scanNetworkDevices(), extra: replyMarkupForCommand(command) };
  }
  if (command === "deviceadd") {
    return { text: await addDevice(args), extra: replyMarkupForCommand(command) };
  }
  if (command === "devicedetail") {
    return { text: await deviceDetail(args), extra: replyMarkupForCommand(command) };
  }
  if (command === "deviceping") {
    return { text: await devicePing(args), extra: replyMarkupForCommand(command) };
  }
  if (command === "deviceports") {
    return { text: await devicePorts(args), extra: replyMarkupForCommand(command) };
  }
  if (command === "wifi") {
    return { text: await currentWifiInfo(), extra: replyMarkupForCommand(command) };
  }
  if (command === "ping") {
    return { text: await pingHost(args), extra: replyMarkupForCommand(command) };
  }
  if (command === "ports") {
    return { text: await scanCommonPorts(args), extra: replyMarkupForCommand(command) };
  }
  if (command === "wix") {
    return { text: await wixSummary(), extra: replyMarkupForCommand(command) };
  }
  if (command === "wixcontacts") {
    return { text: await wixContacts(), extra: replyMarkupForCommand(command) };
  }
  if (command === "notionstatus") {
    return { text: await notionStatus(), extra: replyMarkupForCommand(command) };
  }
  if (command === "notionsearch") {
    return { text: await notionSearchCommand(args), extra: replyMarkupForCommand(command) };
  }
  if (command === "notionopen") {
    return { text: await notionOpenCommand(args), extra: replyMarkupForCommand(command) };
  }
  if (command === "notionpage") {
    return { text: await notionPageCommand(args), extra: replyMarkupForCommand(command) };
  }
  if (command === "notionappend") {
    return { text: await notionAppendCommand(args), extra: replyMarkupForCommand(command) };
  }
  if (command === "notionappendto") {
    return { text: await notionAppendToMatchCommand(args), extra: replyMarkupForCommand(command) };
  }
  if (command === "notioncreate") {
    return { text: await notionCreateCommand(args), extra: replyMarkupForCommand(command) };
  }
  if (command === "notioncreatein") {
    return { text: await notionCreateInMatchCommand(args), extra: replyMarkupForCommand(command) };
  }
  if (command === "notionquery") {
    return { text: await notionQueryCommand(args), extra: replyMarkupForCommand(command) };
  }
  if (command === "notionusers") {
    return { text: await notionUsersCommand(), extra: replyMarkupForCommand(command) };
  }
  if (command === "manus") {
    return { text: await manusTaskCommand(args), extra: replyMarkupForCommand(command) };
  }
  if (command === "manusnotion") {
    return { text: await manusNotionTaskCommand(args), extra: replyMarkupForCommand(command) };
  }
  if (command === "manusstatus") {
    return { text: await manusStatusCommand(args), extra: replyMarkupForCommand(command) };
  }
  if (command === "manuslist") {
    return { text: await manusListCommand(), extra: replyMarkupForCommand(command) };
  }
  if (command === "fetch") {
    return { text: await fetchWebPage(args), extra: replyMarkupForCommand(command) };
  }
  if (command === "providers") {
    return { text: providersSummary(bot), extra: replyMarkupForCommand(command) };
  }
  if (command === "capabilities") {
    return { text: capabilitySummaryText(bot), extra: replyMarkupForCommand(command) };
  }
  if (command === "provider") {
    const profile = findProfile(bot, args);
    if (!profile) {
      throw new Error("Use /provider ollama, /provider cohere, /provider anthropic, /provider openrouter, or /provider openai:project1");
    }
    const listed = await listProviderModels(bot, { profileId: profile.id });
    const modelName = pickCheapestUsefulModel(profile.provider, listed.models);
    const updatedBot = await updateBotAiSettings(bot.id, {
      aiProviderId: profile.id,
      modelName: modelName || ""
    });
    Object.assign(bot, updatedBot);
    return { text: `Active provider changed to ${profile.label}\nModel: ${modelName || "auto"}`, extra: replyMarkupForCommand(command) };
  }
  if (command === "models") {
    return { text: await listModels(bot, args), extra: replyMarkupForCommand(command) };
  }
  if (command === "model") {
    if (!args) {
      throw new Error("Use /model model-name");
    }
    const updatedBot = await updateBotAiSettings(bot.id, {
      aiProviderId: currentSelection(bot).id,
      modelName: args
    });
    Object.assign(bot, updatedBot);
    return { text: `Active model changed to ${args}\nProvider: ${currentSelection(bot).label}`, extra: replyMarkupForCommand(command) };
  }
  if (command === "modeluse") {
    const [rawProvider, ...rest] = String(args || "").split("|");
    const providerToken = String(rawProvider || "").trim();
    const modelName = rest.join("|").trim();
    const profile = findProfile(bot, providerToken);
    if (!profile || !modelName) {
      throw new Error("Use /modeluse provider | model");
    }
    const updatedBot = await updateBotAiSettings(bot.id, {
      aiProviderId: profile.id,
      modelName
    });
    Object.assign(bot, updatedBot);
    return { text: `Active AI selection: ${profile.label} | ${modelName}`, extra: replyMarkupForCommand(command) };
  }
  if (command === "agenthelp") {
    return { text: agentHelpText(), extra: replyMarkupForCommand(command) };
  }
  if (command === "docagent") {
    const parsed = parseAgentTaskArgs(args, "doc");
    return { text: await startAgentTask(bot, token, chatId, parsed.type, parsed.target, parsed.objective), extra: replyMarkupForCommand("tasks") };
  }
  if (command === "sheetagent") {
    const parsed = parseAgentTaskArgs(args, "sheet");
    return { text: await startAgentTask(bot, token, chatId, parsed.type, parsed.target, parsed.objective), extra: replyMarkupForCommand("tasks") };
  }
  if (command === "siteagent") {
    const parsed = parseAgentTaskArgs(args, "site");
    return { text: await startAgentTask(bot, token, chatId, parsed.type, parsed.target, parsed.objective), extra: replyMarkupForCommand("tasks") };
  }
  if (command === "agenttask") {
    const parsed = parseAgentTaskArgs(args);
    return { text: await startAgentTask(bot, token, chatId, parsed.type, parsed.target, parsed.objective), extra: replyMarkupForCommand("tasks") };
  }
  if (command === "supervisor") {
    const parsed = parseAgentTaskArgs(args);
    return { text: await startAgentTask(bot, token, chatId, parsed.type, parsed.target, parsed.objective), extra: replyMarkupForCommand("tasks") };
  }
  if (command === "autopilot") {
    const parsed = parseAgentTaskArgs(args);
    return { text: await startAutopilotTask(bot, token, chatId, parsed.type, parsed.target, parsed.objective), extra: replyMarkupForCommand("tasks") };
  }
  if (command === "squad") {
    const parsed = parseAgentTaskArgs(args);
    return { text: await startSquadTask(bot, token, chatId, parsed.type, parsed.target, parsed.objective), extra: replyMarkupForCommand("tasks") };
  }
  if (command === "delegate") {
    const parsed = parseDelegateArgs(args);
    return {
      text: await startDelegatedTask(bot, token, chatId, parsed.providerToken, parsed.type, parsed.target, parsed.objective),
      extra: replyMarkupForCommand("tasks")
    };
  }
  if (command === "tasks") {
    return { text: await listAgentTasks(bot, chatId), extra: replyMarkupForCommand(command) };
  }
  if (command === "taskstatus") {
    return { text: await agentTaskStatus(bot, chatId, args), extra: replyMarkupForCommand(command) };
  }
  if (command === "tasksend") {
    return { text: await resendAgentTaskOutputs(bot, token, chatId, args), extra: replyMarkupForCommand(command) };
  }
  if (command === "schedulehelp") {
    return { text: scheduleHelpText(), extra: replyMarkupForCommand(command) };
  }
  if (command === "scheduleadd") {
    return { text: await addSchedule(bot, chatId, args), extra: replyMarkupForCommand(command) };
  }
  if (command === "schedules") {
    return { text: await listSchedules(bot, chatId), extra: replyMarkupForCommand(command) };
  }
  if (command === "scheduledelete") {
    return { text: await deleteSchedule(bot, chatId, args), extra: replyMarkupForCommand(command) };
  }
  if (command === "clear") {
    await clearChatState(bot.id, chatId);
    state = { messages: [], mode: currentChatMode(state), capture: null };
    return { text: "Chat memory cleared for this conversation.", extra: replyMarkupForCommand(command), state };
  }

  return { text: `Unknown command: /${command}\n\n${helpText(bot)}`, extra: replyMarkupForCommand("menu") };
}

async function handleCallbackQuery(bot, token, callbackQuery) {
  const chatId = callbackQuery.message && callbackQuery.message.chat && callbackQuery.message.chat.id;
  const messageId = callbackQuery.message && callbackQuery.message.message_id;
  const data = String(callbackQuery.data || "").trim();
  if (!chatId || !messageId || !data) {
    return;
  }

  try {
    await telegram(token, "answerCallbackQuery", {
      callback_query_id: callbackQuery.id,
      text: "Working on it..."
    }).catch(() => {});

    const roots = getAllowedRoots(bot);
    let response;

    if (data === "nav:home") {
      response = navigationScreen(bot, "dashboard");
    } else if (data.startsWith("nav:")) {
      response = navigationScreen(bot, data.slice(4));
    } else if (data.startsWith("cmd:")) {
      const commandText = data.slice(4).trim();
      const { command, args } = splitCommand(commandText.startsWith("/") ? commandText : `/${commandText}`);
      response = await executeTelegramCommand(bot, token, command, args, roots, chatId);
    } else {
      response = { text: "That button action is not wired yet.", extra: replyMarkupForCommand("menu", true) };
    }

    await telegram(token, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: truncateForTelegram(response.text),
      ...response.extra
    }).catch(async () => {
      await sendTelegramText(token, chatId, response.text, response.extra || replyMarkupForCommand("menu"));
    });
  } catch (error) {
    await telegram(token, "answerCallbackQuery", {
      callback_query_id: callbackQuery.id,
      text: error.message || "Action failed.",
      show_alert: false
    }).catch(() => {});
  }
}

async function handleMessage(bot, token, message) {
  const text = String(message.text || "").trim();
  const chatId = message.chat && message.chat.id;
  if (!chatId || !text) {
    return;
  }

  const roots = getAllowedRoots(bot);
  let state = await readChatState(bot.id, chatId);
  const stopTyping = startTypingLoop(token, chatId);

  try {
    let reply = "";
    let extra = {};

    if (!text.startsWith("/") && state.capture && state.capture.targetPath) {
      state = await appendCaptureText(state, text);
      reply = `Captured chunk ${state.capture.chunks} to ${state.capture.targetPath}\n\nSend /capturedone when you're ready for the plan pack.`;
      extra = replyMarkupForCommand("workbench");
    } else if (text.startsWith("/")) {
      const { command, args } = splitCommand(text);
      const response = await executeTelegramCommand(bot, token, command, args, roots, chatId);
      reply = response.text;
      extra = response.extra || {};
      if (response.state) {
        state = response.state;
      }
    } else {
      const quickIntent = parseQuickIntent(text);
      if (quickIntent) {
        const response = await executeTelegramCommand(bot, token, quickIntent.command, quickIntent.args, roots, chatId);
        reply = response.text;
        extra = response.extra || {};
        if (response.state) {
          state = response.state;
        }
      } else {
        state = pushChatMessage(state, "user", text);
        reply = await handleNaturalLanguage(bot, text, roots, state);
        extra = replyMarkupForCommand("menu");
      }
    }
    await sendTelegramText(token, chatId, reply, extra);

    state = pushChatMessage(state, "assistant", reply);
    await writeChatState(bot.id, chatId, state);
  } catch (error) {
    await appendRunnerLog(bot.id, `message error chat=${chatId} text=${JSON.stringify(text).slice(0, 400)} error=${error.stack || error.message || String(error)}`);
    if (!isRateLimitError(error)) {
      await sendTelegramText(token, chatId, `Error: ${userFacingErrorMessage(error)}`).catch(() => {});
    } else {
      await appendRunnerLog(bot.id, `rate-limit suppress chat=${chatId} retryAfterMs=${retryAfterMs(error)}`);
    }
  } finally {
    stopTyping();
  }
}

async function warmLocalSupervisor(bot) {
  try {
    await generateText(
      bot,
      "Reply with exactly READY.",
      "You are warming up the local Telegram supervisor model. Reply with exactly READY.",
      {
        profileId: "ollama:local",
        model: bot.ollamaModel || "qwen2.5-coder:7b",
        strict: true
      }
    );
  } catch (error) {
    await appendRunnerLog(bot.id, `local warmup failed: ${error.message || String(error)}`);
  }
}

async function ensureDirs() {
  await fsp.mkdir(STORAGE_DIR, { recursive: true });
  await fsp.mkdir(LOG_DIR, { recursive: true });
  await fsp.mkdir(CHAT_DIR, { recursive: true });
  if (!fs.existsSync(SCHEDULES_FILE)) {
    await writeSchedules([]);
  }
  if (!fs.existsSync(DEVICES_FILE)) {
    await writeDevices([]);
  }
  if (!fs.existsSync(AGENT_TASKS_FILE)) {
    await writeAgentTasks([]);
  }
}

async function configureTelegramSurface(token) {
  await telegram(token, "setMyCommands", { commands: telegramCommandList() }).catch(() => {});
  await telegram(token, "setMyDescription", {
    description: "Local-first AI command center for files, documents, build tasks, Wix, Notion, network tools, and multi-model agent work."
  }).catch(() => {});
  await telegram(token, "setMyShortDescription", {
    short_description: "Local qwen-powered AI operator with docs, build, and agent tools."
  }).catch(() => {});
  await telegram(token, "setChatMenuButton", {
    menu_button: {
      type: "commands"
    }
  }).catch(() => {});
}

async function main() {
  await ensureDirs();

  const botArg = resolveBotArg();
  const bots = await readBots();
  const bot = findBot(bots, botArg);
  if (!bot) {
    throw new Error(`Could not find bot for selector "${botArg || "default"}".`);
  }
  bot.ollamaModel = bot.ollamaModel || "qwen2.5-coder:7b";
  bot.aiProviderId = "ollama:local";
  bot.modelProvider = "ollama";
  bot.providerProfile = "local";
  bot.modelName = bot.ollamaModel;
  await updateBotAiSettings(bot.id, {
    aiProviderId: "ollama:local",
    modelName: bot.ollamaModel
  }).catch(() => {});

  const token = decryptSecret(bot.tokenEncrypted);
  const stateFile = path.join(STORAGE_DIR, `runner-state-${bot.id}.json`);
  let offset = 0;

  try {
    const rawState = JSON.parse(await fsp.readFile(stateFile, "utf8"));
    offset = Number(rawState.offset || 0);
  } catch {
    offset = 0;
  }

  await telegram(token, "deleteWebhook", { drop_pending_updates: false });
  await configureTelegramSurface(token);

  const info = await telegram(token, "getMe");
  await fsp.writeFile(
    path.join(LOG_DIR, `runner-${bot.id}.log`),
    `${new Date().toISOString()} runner started for @${info.username || info.first_name}\n`,
    { flag: "a" }
  );

  await processSchedules(bot, token).catch(() => {});
  warmLocalSupervisor(bot).catch(() => {});
  setInterval(() => {
    processSchedules(bot, token).catch(async (error) => {
      await fsp.writeFile(
        path.join(LOG_DIR, `runner-${bot.id}.log`),
        `${new Date().toISOString()} schedule retry: ${error.message || String(error)}\n`,
        { flag: "a" }
      ).catch(() => {});
    });
  }, SCHEDULER_TICK_MS);

  while (true) {
    try {
      const updates = await telegram(token, "getUpdates", {
        offset,
        timeout: 45,
        allowed_updates: ["message", "callback_query"]
      });

      for (const update of updates) {
        offset = Math.max(offset, Number(update.update_id) + 1);
        await fsp.writeFile(stateFile, JSON.stringify({ offset }, null, 2), "utf8");
        const updateKey = update.message
          ? `m:${update.message.chat?.id}:${update.message.message_id}`
          : update.callback_query
            ? `c:${update.callback_query.id}`
            : `u:${update.update_id}`;
        if (touchRecentKey(RECENT_UPDATE_KEYS, updateKey, UPDATE_DEDUPE_TTL_MS)) {
          await appendRunnerLog(bot.id, `duplicate update skipped ${updateKey}`);
          continue;
        }
        if (update.message) {
          await handleMessage(bot, token, update.message);
        } else if (update.callback_query) {
          await handleCallbackQuery(bot, token, update.callback_query);
        }
      }
    } catch (error) {
      await fsp.writeFile(
        path.join(LOG_DIR, `runner-${bot.id}.log`),
        `${new Date().toISOString()} polling retry: ${error.message || String(error)}\n`,
        { flag: "a" }
      );
      await new Promise((resolve) => setTimeout(resolve, isRateLimitError(error) ? retryAfterMs(error, POLL_BACKOFF_MS) : POLL_BACKOFF_MS));
    }
  }
}

main().catch(async (error) => {
  try {
    await ensureDirs();
    await fsp.writeFile(
      path.join(LOG_DIR, "runner-error.log"),
      `${new Date().toISOString()} ${error.stack || error.message || String(error)}\n`,
      { flag: "a" }
    );
  } catch {}
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
