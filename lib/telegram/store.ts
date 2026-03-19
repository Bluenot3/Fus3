import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { decryptSecret, encryptSecret } from "@/lib/secrets/crypto";
import {
  getTelegramBotIdentity,
  getTelegramWebhookInfo,
  sendTelegramMessage,
  setTelegramCommands,
  type TelegramCommand,
  type TelegramWebhookInfo
} from "@/lib/telegram/client";

const STORAGE_DIR = path.join(process.cwd(), "storage", "telegram");
const STORAGE_FILE = path.join(STORAGE_DIR, "bots.json");

export type TelegramBotProfileInput = {
  name: string;
  token: string;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  systemPrompt?: string;
  knowledgePaths?: string[];
  googleDriveLinks?: string[];
  integrationNotes?: string;
  commands?: TelegramCommand[];
  testChatId?: string;
};

type TelegramBotRecord = {
  id: string;
  name: string;
  tokenEncrypted: string;
  telegramId: number;
  username: string | null;
  displayName: string;
  canJoinGroups: boolean;
  canReadAllGroupMessages: boolean;
  supportsInlineQueries: boolean;
  ollamaBaseUrl: string;
  ollamaModel: string;
  systemPrompt: string;
  knowledgePaths: string[];
  googleDriveLinks: string[];
  integrationNotes: string;
  commands: TelegramCommand[];
  testChatId: string;
  createdAt: string;
  updatedAt: string;
};

export type TelegramBotSummary = Omit<TelegramBotRecord, "tokenEncrypted"> & {
  webhook: TelegramWebhookInfo | null;
};

type TelegramBotPatch = Partial<Omit<TelegramBotProfileInput, "token">> & { token?: string };

async function ensureStorage() {
  await mkdir(STORAGE_DIR, { recursive: true });
}

async function readRecords(): Promise<TelegramBotRecord[]> {
  try {
    const raw = await readFile(STORAGE_FILE, "utf8");
    const parsed = JSON.parse(raw) as { bots?: TelegramBotRecord[] };
    return parsed.bots ?? [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function writeRecords(records: TelegramBotRecord[]) {
  await ensureStorage();
  await writeFile(STORAGE_FILE, JSON.stringify({ bots: records }, null, 2), "utf8");
}

function cleanLines(values?: string[]): string[] {
  return (values ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
}

function cleanCommands(commands?: TelegramCommand[]): TelegramCommand[] {
  return (commands ?? [])
    .map((command) => ({
      command: command.command.trim().replace(/^\//, ""),
      description: command.description.trim()
    }))
    .filter((command) => command.command && command.description);
}

function toSummary(record: TelegramBotRecord, webhook: TelegramWebhookInfo | null): TelegramBotSummary {
  return {
    id: record.id,
    name: record.name,
    telegramId: record.telegramId,
    username: record.username,
    displayName: record.displayName,
    canJoinGroups: record.canJoinGroups,
    canReadAllGroupMessages: record.canReadAllGroupMessages,
    supportsInlineQueries: record.supportsInlineQueries,
    ollamaBaseUrl: record.ollamaBaseUrl,
    ollamaModel: record.ollamaModel,
    systemPrompt: record.systemPrompt,
    knowledgePaths: record.knowledgePaths,
    googleDriveLinks: record.googleDriveLinks,
    integrationNotes: record.integrationNotes,
    commands: record.commands,
    testChatId: record.testChatId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    webhook
  };
}

export async function listTelegramBots(): Promise<TelegramBotSummary[]> {
  const records = await readRecords();

  return Promise.all(
    records.map(async (record) => {
      try {
        const webhook = await getTelegramWebhookInfo(decryptSecret(record.tokenEncrypted));
        return toSummary(record, webhook);
      } catch {
        return toSummary(record, null);
      }
    })
  );
}

export async function createTelegramBot(input: TelegramBotProfileInput): Promise<TelegramBotSummary> {
  const token = input.token.trim();
  if (!token) {
    throw new Error("Telegram bot token is required.");
  }

  const identity = await getTelegramBotIdentity(token);
  const webhook = await getTelegramWebhookInfo(token).catch(() => null);
  const now = new Date().toISOString();
  const record: TelegramBotRecord = {
    id: randomUUID(),
    name: input.name.trim() || identity.username || identity.first_name,
    tokenEncrypted: encryptSecret(token),
    telegramId: identity.id,
    username: identity.username ?? null,
    displayName: identity.first_name,
    canJoinGroups: Boolean(identity.can_join_groups),
    canReadAllGroupMessages: Boolean(identity.can_read_all_group_messages),
    supportsInlineQueries: Boolean(identity.supports_inline_queries),
    ollamaBaseUrl: input.ollamaBaseUrl?.trim() || "http://127.0.0.1:11434",
    ollamaModel: input.ollamaModel?.trim() || "",
    systemPrompt: input.systemPrompt?.trim() || "",
    knowledgePaths: cleanLines(input.knowledgePaths),
    googleDriveLinks: cleanLines(input.googleDriveLinks),
    integrationNotes: input.integrationNotes?.trim() || "",
    commands: cleanCommands(input.commands),
    testChatId: input.testChatId?.trim() || "",
    createdAt: now,
    updatedAt: now
  };

  const records = await readRecords();
  records.unshift(record);
  await writeRecords(records);

  if (record.commands.length) {
    await setTelegramCommands(token, record.commands);
  }

  return toSummary(record, webhook);
}

export async function updateTelegramBot(botId: string, patch: TelegramBotPatch): Promise<TelegramBotSummary> {
  const records = await readRecords();
  const index = records.findIndex((record) => record.id === botId);

  if (index < 0) {
    throw new Error("Telegram bot not found.");
  }

  const current = records[index];
  let tokenEncrypted = current.tokenEncrypted;
  let identity: {
    id: number;
    username?: string;
    first_name: string;
    can_join_groups?: boolean;
    can_read_all_group_messages?: boolean;
    supports_inline_queries?: boolean;
  } = {
    id: current.telegramId,
    username: current.username ?? undefined,
    first_name: current.displayName,
    can_join_groups: current.canJoinGroups,
    can_read_all_group_messages: current.canReadAllGroupMessages,
    supports_inline_queries: current.supportsInlineQueries
  };

  if (patch.token?.trim()) {
    identity = await getTelegramBotIdentity(patch.token.trim());
    tokenEncrypted = encryptSecret(patch.token.trim());
  }

  const updated: TelegramBotRecord = {
    ...current,
    name: patch.name?.trim() || current.name,
    tokenEncrypted,
    telegramId: identity.id,
    username: identity.username ?? null,
    displayName: identity.first_name,
    canJoinGroups: Boolean(identity.can_join_groups),
    canReadAllGroupMessages: Boolean(identity.can_read_all_group_messages),
    supportsInlineQueries: Boolean(identity.supports_inline_queries),
    ollamaBaseUrl: patch.ollamaBaseUrl?.trim() || current.ollamaBaseUrl,
    ollamaModel: patch.ollamaModel?.trim() ?? current.ollamaModel,
    systemPrompt: patch.systemPrompt?.trim() ?? current.systemPrompt,
    knowledgePaths: patch.knowledgePaths ? cleanLines(patch.knowledgePaths) : current.knowledgePaths,
    googleDriveLinks: patch.googleDriveLinks ? cleanLines(patch.googleDriveLinks) : current.googleDriveLinks,
    integrationNotes: patch.integrationNotes?.trim() ?? current.integrationNotes,
    commands: patch.commands ? cleanCommands(patch.commands) : current.commands,
    testChatId: patch.testChatId?.trim() ?? current.testChatId,
    updatedAt: new Date().toISOString()
  };

  records[index] = updated;
  await writeRecords(records);

  if (updated.commands.length) {
    await setTelegramCommands(decryptSecret(updated.tokenEncrypted), updated.commands);
  }

  const webhook = await getTelegramWebhookInfo(decryptSecret(updated.tokenEncrypted)).catch(() => null);
  return toSummary(updated, webhook);
}

export async function deleteTelegramBot(botId: string) {
  const records = await readRecords();
  const next = records.filter((record) => record.id !== botId);
  if (next.length === records.length) {
    throw new Error("Telegram bot not found.");
  }
  await writeRecords(next);
}

async function findRecord(botId: string): Promise<TelegramBotRecord> {
  const records = await readRecords();
  const record = records.find((entry) => entry.id === botId);
  if (!record) {
    throw new Error("Telegram bot not found.");
  }
  return record;
}

export async function applyTelegramBotCommands(botId: string, commands?: TelegramCommand[]) {
  const record = await findRecord(botId);
  const token = decryptSecret(record.tokenEncrypted);
  const nextCommands = cleanCommands(commands ?? record.commands);

  if (!nextCommands.length) {
    throw new Error("Add at least one Telegram command before applying.");
  }

  await setTelegramCommands(token, nextCommands);
  return { ok: true, count: nextCommands.length };
}

export async function sendTelegramBotTestMessage(botId: string, chatId: string, text: string) {
  const record = await findRecord(botId);
  const token = decryptSecret(record.tokenEncrypted);
  const resolvedChatId = chatId.trim() || record.testChatId;

  if (!resolvedChatId) {
    throw new Error("A Telegram chat ID is required for test messages.");
  }

  if (!text.trim()) {
    throw new Error("Test message text is required.");
  }

  return sendTelegramMessage(token, resolvedChatId, text.trim());
}
