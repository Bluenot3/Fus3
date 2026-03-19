const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { exec } = require("child_process");
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

const ROOT = process.cwd();
const STORAGE_DIR = path.join(ROOT, "storage", "telegram");
const BOTS_FILE = path.join(STORAGE_DIR, "bots.json");
const LOG_DIR = path.join(STORAGE_DIR, "logs");
const CHAT_DIR = path.join(STORAGE_DIR, "chats");
const SCHEDULES_FILE = path.join(STORAGE_DIR, "schedules.json");
const DEVICES_FILE = path.join(STORAGE_DIR, "devices.json");
const DEFAULT_TIMEOUT_MS = 20000;
const TELEGRAM_LIMIT = 3900;
const MAX_HISTORY_MESSAGES = 10;
const MAX_TOOL_ACTIONS = 3;
const SEARCH_RESULT_LIMIT = 25;
const POLL_BACKOFF_MS = 8000;
const SCHEDULER_TICK_MS = 15000;
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
    throw new Error(payload.description || `Telegram ${method} failed`);
  }
  return payload.result;
}

async function sendTelegramText(token, chatId, text, extra = {}) {
  return telegram(token, "sendMessage", {
    chat_id: chatId,
    text: truncateForTelegram(text),
    ...extra
  });
}

function commandKeyboard() {
  return {
    keyboard: [
      [{ text: "/menu" }, { text: "/status" }, { text: "/health" }],
      [{ text: "/files" }, { text: "/project" }, { text: "/wix" }],
      [{ text: "/notionstatus" }, { text: "/notionsearch" }, { text: "/manuslist" }],
      [{ text: "/network" }, { text: "/wifi" }, { text: "/gitstatus" }],
      [{ text: "/schedules" }, { text: "/schedulehelp" }],
      [{ text: "/models" }, { text: "/clear" }]
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
    [{ text: "Manus", data: "cmd:manuslist" }, { text: "Network", data: "cmd:network" }],
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
    [{ text: "Tree", data: "cmd:tree" }, { text: "Schedules", data: "cmd:schedules" }],
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
  if (key === "schedules") {
    return { text: "Schedules panel", extra: { reply_markup: scheduleInlineKeyboard() } };
  }
  return { text: dashboardText(bot), extra: { reply_markup: dashboardInlineKeyboard() } };
}

function dashboardText(bot) {
  return [
    `${bot.name} control center`,
    "",
    "Use the sections below for network, files, integrations, and scheduling.",
    "Natural language still works, but the button layout makes the high-value actions much faster."
  ].join("\n");
}

function dashboardInlineKeyboard() {
  return inlineKeyboard([
    [{ text: "Control", data: "nav:control" }, { text: "Network", data: "nav:network" }],
    [{ text: "Devices", data: "nav:devices" }, { text: "Integrations", data: "nav:integrations" }],
    [{ text: "Files", data: "nav:files" }, { text: "Schedules", data: "nav:schedules" }]
  ]);
}

function controlInlineKeyboard() {
  return inlineKeyboard([
    [{ text: "Status", data: "cmd:status" }, { text: "Health", data: "cmd:health" }],
    [{ text: "Project", data: "cmd:project" }, { text: "Models", data: "cmd:models" }],
    [{ text: "Home", data: "nav:dashboard" }]
  ]);
}

function integrationsInlineKeyboard() {
  return inlineKeyboard([
    [{ text: "Wix", data: "cmd:wix" }, { text: "Notion", data: "cmd:notionstatus" }],
    [{ text: "Manus", data: "cmd:manuslist" }, { text: "Users", data: "cmd:notionusers" }],
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

function replyMarkupForCommand(command, forceInline = false) {
  const inline =
    command === "menu" || command === "dashboard"
      ? dashboardInlineKeyboard()
      : command === "wix" || command === "wixcontacts"
      ? wixInlineKeyboard()
      : command === "notionstatus" || command === "notionsearch" || command === "notionopen" || command === "notionpage" || command === "notionappend" || command === "notionappendto" || command === "notioncreate" || command === "notioncreatein" || command === "notionquery" || command === "notionusers"
        ? notionInlineKeyboard()
      : command === "manus" || command === "manusstatus" || command === "manuslist"
        ? manusInlineKeyboard()
      : command === "devices" || command === "devicescan" || command === "deviceadd" || command === "deviceping" || command === "deviceports" || command === "devicedetail"
        ? devicesInlineKeyboard()
      : command === "schedules" || command === "scheduleadd" || command === "scheduledelete" || command === "schedulehelp"
        ? scheduleInlineKeyboard()
      : command === "network" || command === "wifi" || command === "ping" || command === "ports"
        ? networkInlineKeyboard()
        : command === "files" || command === "find" || command === "grep" || command === "gitstatus" || command === "gitlog" || command === "project"
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

  const candidate = path.isAbsolute(value) ? path.resolve(value) : path.resolve(roots[0], value);
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
    `Ollama base: ${bot.ollamaBaseUrl || "not set"}`,
    `Ollama model: ${bot.ollamaModel || "not set"}`,
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

async function listModels(bot) {
  const response = await fetch(`${String(bot.ollamaBaseUrl || "http://127.0.0.1:11434").replace(/\/+$/, "")}/api/tags`, {
    method: "GET"
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Could not reach Ollama.");
  }
  const models = Array.isArray(payload.models) ? payload.models : [];
  return [
    "Available Ollama models:",
    "",
    ...models.map((model) => `- ${model.name || model.model}`)
  ].join("\n");
}

async function askModel(bot, prompt, systemOverride) {
  if (!bot.ollamaModel) {
    throw new Error("No Ollama model is configured for this bot yet.");
  }
  if (!prompt) {
    throw new Error("Prompt is required.");
  }

  const response = await fetch(`${String(bot.ollamaBaseUrl || "http://127.0.0.1:11434").replace(/\/+$/, "")}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: bot.ollamaModel,
      system: systemOverride || bot.systemPrompt || "",
      prompt,
      stream: false
    })
  });

  const payload = await response.json();
  if (!response.ok || !payload.response) {
    throw new Error(payload.error || "Ollama request failed.");
  }

  return String(payload.response).trim();
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
    "/status - show current laptop bot status",
    "/health - show connection and runner health",
    "/roots - list allowed roots",
    "/files [path] - list files",
    "/tree [path] - show a file tree",
    "/project - summarize the current workspace",
    "/fileinfo path - show file details",
    "/read path - read a text file",
    "/write path | content - write a file",
    "/append path | content - append to a file",
    "/mkdir path - create a directory",
    "/copy source | target - copy a file or folder",
    "/move source | target - move a file or folder",
    "/run command - run a PowerShell command in the primary root",
    "/ask prompt - send a prompt to Ollama",
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
    "/models - list Ollama models",
    "/model name - change the active model",
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
    { command: "menu", description: "Show the quick action menu" },
    { command: "status", description: "Show bot and workspace status" },
    { command: "health", description: "Check runner, Wi-Fi, internet, and Ollama" },
    { command: "files", description: "List files in a folder" },
    { command: "tree", description: "Show a file tree" },
    { command: "project", description: "Summarize the current project" },
    { command: "fileinfo", description: "Show file details" },
    { command: "gitstatus", description: "Show git status" },
    { command: "network", description: "Show local network overview" },
    { command: "devices", description: "List saved and scanned devices" },
    { command: "devicescan", description: "Quick scan the local subnet" },
    { command: "wifi", description: "Show current Wi-Fi details" },
    { command: "wix", description: "Show Wix site summary" },
    { command: "notionstatus", description: "Check Notion connection" },
    { command: "notionsearch", description: "Search accessible Notion content" },
    { command: "manus", description: "Start a low-cost Manus task" },
    { command: "manuslist", description: "List recent Manus tasks" },
    { command: "models", description: "List Ollama models" },
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
    return JSON.parse(raw);
  } catch {
    return { messages: [] };
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
    messages: next.slice(-MAX_HISTORY_MESSAGES)
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

async function executeToolAction(bot, action, roots) {
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
        `Ollama model: ${bot.ollamaModel || "not set"}`
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

  return [
    "You are a Telegram laptop assistant with access to local tools.",
    bot.systemPrompt || "",
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
    "",
    "Rules:",
    "- Return only valid JSON.",
    "- Use at most 3 tool actions.",
    "- Prefer a normal reply when the user is chatting casually.",
    "- Only use file tools for paths inside allowed roots.",
    "- This planner is read-only by default. Do not write files, create folders, or run arbitrary commands.",
    "- For risky or state-changing requests, reply with guidance instead of taking action.",
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

async function handleNaturalLanguage(bot, userText, roots, state) {
  const plannerPrompt = buildPlannerPrompt(bot, roots, state, userText);
  const plannerResponse = await askModel(
    bot,
    plannerPrompt,
    "You are a strict JSON planner. Return JSON only with no markdown fences."
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
      toolResults.push(await executeToolAction(bot, action, roots));
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
    "You are a concise Telegram assistant. No markdown tables. Keep replies short and useful."
  );

  return truncateForTelegram(finalResponse);
}

async function updateBotModel(botId, modelName) {
  const bots = await readBots();
  const index = bots.findIndex((bot) => bot.id === botId);
  if (index < 0) {
    throw new Error("Bot not found.");
  }
  bots[index].ollamaModel = modelName;
  bots[index].updatedAt = new Date().toISOString();
  await fsp.writeFile(BOTS_FILE, JSON.stringify({ bots }, null, 2), "utf8");
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
  const roots = Array.isArray(bot.knowledgePaths) && bot.knowledgePaths.length ? bot.knowledgePaths : [ROOT];
  let state = await readChatState(bot.id, chatId);
  let reply = "";
  let extra = {};

  if (String(schedule.payload || "").trim().startsWith("/")) {
    const { command, args } = splitCommand(schedule.payload);
    const response = await executeTelegramCommand(bot, command, args, roots, chatId);
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

async function executeTelegramCommand(bot, command, args, roots, chatId) {
  let state = null;

  if (command === "start" || command === "help") {
    return { text: helpText(bot), extra: { reply_markup: commandKeyboard() } };
  }
  if (command === "menu" || command === "dashboard") {
    return { text: dashboardText(bot), extra: { reply_markup: dashboardInlineKeyboard() } };
  }
  if (command === "status") {
    return {
      text: [
        `${bot.name} is online.`,
        `Primary root: ${roots[0]}`,
        `Allowed roots: ${roots.length}`,
        `Ollama base: ${bot.ollamaBaseUrl || "not set"}`,
        `Ollama model: ${bot.ollamaModel || "not set"}`
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
  if (command === "fileinfo") {
    return { text: await fileInfoCommand(args, roots), extra: replyMarkupForCommand(command) };
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
  if (command === "models") {
    return { text: await listModels(bot), extra: replyMarkupForCommand(command) };
  }
  if (command === "model") {
    if (!args) {
      throw new Error("Use /model model-name");
    }
    await updateBotModel(bot.id, args);
    bot.ollamaModel = args;
    return { text: `Active model changed to ${args}`, extra: replyMarkupForCommand(command) };
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
    state = { messages: [] };
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

    const roots = Array.isArray(bot.knowledgePaths) && bot.knowledgePaths.length ? bot.knowledgePaths : [ROOT];
    let response;

    if (data === "nav:home") {
      response = navigationScreen(bot, "dashboard");
    } else if (data.startsWith("nav:")) {
      response = navigationScreen(bot, data.slice(4));
    } else if (data.startsWith("cmd:")) {
      const commandText = data.slice(4).trim();
      const { command, args } = splitCommand(commandText.startsWith("/") ? commandText : `/${commandText}`);
      response = await executeTelegramCommand(bot, command, args, roots, chatId);
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

  const roots = Array.isArray(bot.knowledgePaths) && bot.knowledgePaths.length ? bot.knowledgePaths : [ROOT];
  let state = await readChatState(bot.id, chatId);

  try {
    let reply = "";
    let extra = {};

    if (text.startsWith("/")) {
      const { command, args } = splitCommand(text);
      const response = await executeTelegramCommand(bot, command, args, roots, chatId);
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

    await telegram(token, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
    await sendTelegramText(token, chatId, reply, extra);

    state = pushChatMessage(state, "assistant", reply);
    await writeChatState(bot.id, chatId, state);
  } catch (error) {
    await sendTelegramText(token, chatId, `Error: ${error.message || String(error)}`);
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
}

async function configureTelegramSurface(token) {
  await telegram(token, "setMyCommands", { commands: telegramCommandList() }).catch(() => {});
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
      await new Promise((resolve) => setTimeout(resolve, POLL_BACKOFF_MS));
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
