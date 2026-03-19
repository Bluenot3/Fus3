"use client";

import Link from "next/link";
import { Bot, FolderSearch, Globe, KeyRound, MessageCircle, RefreshCcw, Save, Send, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type TelegramCommand = {
  command: string;
  description: string;
};

type TelegramBotSummary = {
  id: string;
  name: string;
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
  webhook: {
    url: string;
    pending_update_count: number;
    last_error_message?: string;
    allowed_updates?: string[];
  } | null;
};

type OllamaModel = {
  name: string;
  model: string;
  modifiedAt: string | null;
  size: number | null;
  parameterSize: string | null;
  family: string | null;
};

type FormState = {
  name: string;
  token: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  systemPrompt: string;
  knowledgePaths: string;
  googleDriveLinks: string;
  integrationNotes: string;
  commands: string;
  testChatId: string;
};

const EMPTY_FORM: FormState = {
  name: "",
  token: "",
  ollamaBaseUrl: "http://127.0.0.1:11434",
  ollamaModel: "",
  systemPrompt: "",
  knowledgePaths: "",
  googleDriveLinks: "",
  integrationNotes: "",
  commands: "/start - Introduce the bot\n/status - Show current workspace status",
  testChatId: ""
};

const SECTIONS = [
  { id: "telegram", label: "Telegram" },
  { id: "files", label: "Files" },
  { id: "site", label: "Site" }
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

function parseLines(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseCommands(value: string): TelegramCommand[] {
  return parseLines(value)
    .map((line) => {
      const normalized = line.replace(/^\//, "");
      const [command, ...rest] = normalized.split("-");
      return {
        command: command?.trim() || "",
        description: rest.join("-").trim() || "Command"
      };
    })
    .filter((command) => command.command && command.description);
}

function formatCommands(commands: TelegramCommand[]) {
  return commands.map((command) => `/${command.command} - ${command.description}`).join("\n");
}

function toFormState(bot?: TelegramBotSummary): FormState {
  if (!bot) {
    return EMPTY_FORM;
  }

  return {
    name: bot.name,
    token: "",
    ollamaBaseUrl: bot.ollamaBaseUrl,
    ollamaModel: bot.ollamaModel,
    systemPrompt: bot.systemPrompt,
    knowledgePaths: bot.knowledgePaths.join("\n"),
    googleDriveLinks: bot.googleDriveLinks.join("\n"),
    integrationNotes: bot.integrationNotes,
    commands: formatCommands(bot.commands),
    testChatId: bot.testChatId
  };
}

export function MobileCommandCenter() {
  const [section, setSection] = useState<SectionId>("telegram");
  const [bots, setBots] = useState<TelegramBotSummary[]>([]);
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isApplyingCommands, setIsApplyingCommands] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedBot = useMemo(
    () => bots.find((bot) => bot.id === selectedBotId) ?? null,
    [bots, selectedBotId]
  );

  const loadBots = async () => {
    setIsLoading(true);
    try {
      const response = await fetch("/api/telegram/bots", { cache: "no-store" });
      const payload = (await response.json()) as { ok: boolean; bots?: TelegramBotSummary[]; error?: string };

      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "Failed to load Telegram bots.");
      }

      const nextBots = payload.bots ?? [];
      setBots(nextBots);

      if (selectedBotId) {
        const refreshedSelected = nextBots.find((bot) => bot.id === selectedBotId);
        if (refreshedSelected) {
          setForm((current) => ({ ...toFormState(refreshedSelected), token: current.token }));
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load Telegram bots.");
    } finally {
      setIsLoading(false);
    }
  };

  const loadModels = async (baseUrl: string) => {
    try {
      const response = await fetch(`/api/ollama/models?baseUrl=${encodeURIComponent(baseUrl)}`, { cache: "no-store" });
      const payload = (await response.json()) as { ok: boolean; models?: OllamaModel[] };
      if (!response.ok || !payload.ok) {
        return;
      }
      setModels(payload.models ?? []);
    } catch {
      // Leave models empty if Ollama isn't up yet.
    }
  };

  useEffect(() => {
    void loadBots();
  }, []);

  useEffect(() => {
    void loadModels(form.ollamaBaseUrl || EMPTY_FORM.ollamaBaseUrl);
  }, [form.ollamaBaseUrl]);

  const startNewBot = () => {
    setSelectedBotId(null);
    setForm(EMPTY_FORM);
    setNotice(null);
    setError(null);
  };

  const chooseBot = (bot: TelegramBotSummary) => {
    setSelectedBotId(bot.id);
    setForm(toFormState(bot));
    setSection("telegram");
    setNotice(null);
    setError(null);
  };

  const saveBot = async () => {
    setIsSaving(true);
    setNotice(null);
    setError(null);

    try {
      const payload = {
        name: form.name,
        token: form.token,
        ollamaBaseUrl: form.ollamaBaseUrl,
        ollamaModel: form.ollamaModel,
        systemPrompt: form.systemPrompt,
        knowledgePaths: parseLines(form.knowledgePaths),
        googleDriveLinks: parseLines(form.googleDriveLinks),
        integrationNotes: form.integrationNotes,
        commands: parseCommands(form.commands),
        testChatId: form.testChatId
      };

      const response = await fetch(selectedBot ? `/api/telegram/bots/${selectedBot.id}` : "/api/telegram/bots", {
        method: selectedBot ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const result = (await response.json()) as { ok: boolean; bot?: TelegramBotSummary; error?: string };

      if (!response.ok || !result.ok || !result.bot) {
        throw new Error(result.error || "Failed to save Telegram bot.");
      }

      setNotice(selectedBot ? "Bot settings updated." : "Bot connected successfully.");
      setSelectedBotId(result.bot.id);
      setForm(toFormState(result.bot));
      await loadBots();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to save Telegram bot.");
    } finally {
      setIsSaving(false);
    }
  };

  const sendTestMessage = async () => {
    if (!selectedBot) {
      setError("Connect or select a bot first.");
      return;
    }

    setIsTesting(true);
    setNotice(null);
    setError(null);

    try {
      const response = await fetch(`/api/telegram/bots/${selectedBot.id}/test-message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId: form.testChatId,
          text: "Command center check-in: the bot is connected and ready for the next runtime step."
        })
      });

      const payload = (await response.json()) as { ok: boolean; error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "Failed to send test message.");
      }

      setNotice("Test message sent.");
      await loadBots();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to send test message.");
    } finally {
      setIsTesting(false);
    }
  };

  const applyCommands = async () => {
    if (!selectedBot) {
      setError("Select a bot before applying commands.");
      return;
    }

    setIsApplyingCommands(true);
    setNotice(null);
    setError(null);

    try {
      const response = await fetch(`/api/telegram/bots/${selectedBot.id}/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commands: parseCommands(form.commands) })
      });

      const payload = (await response.json()) as { ok: boolean; error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "Failed to apply commands.");
      }

      setNotice("Telegram bot commands updated.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to apply commands.");
    } finally {
      setIsApplyingCommands(false);
    }
  };

  const removeBot = async () => {
    if (!selectedBot) {
      return;
    }

    setNotice(null);
    setError(null);

    try {
      const response = await fetch(`/api/telegram/bots/${selectedBot.id}`, { method: "DELETE" });
      const payload = (await response.json()) as { ok: boolean; error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "Failed to delete bot.");
      }
      setNotice("Bot removed.");
      startNewBot();
      await loadBots();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to delete bot.");
    }
  };

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(251,191,36,0.14),_transparent_30%),linear-gradient(180deg,_#fcfaf6_0%,_#f2ece2_100%)] px-4 py-5 text-stone-900">
      <section className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-4">
        <header className="rounded-[28px] border border-stone-200/90 bg-white/88 p-5 shadow-[0_18px_48px_rgba(90,69,38,0.08)] backdrop-blur">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-amber-700">ZEN Local Command</p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-stone-950">Fast control on iPhone.</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-600">
                Telegram bot setup first, with cleaner navigation for Wix and local file workflows.
              </p>
            </div>

            <button
              type="button"
              onClick={() => {
                void loadBots();
                void loadModels(form.ollamaBaseUrl || EMPTY_FORM.ollamaBaseUrl);
              }}
              className="inline-flex shrink-0 items-center gap-2 rounded-full border border-stone-300 bg-stone-50 px-4 py-2 text-sm font-medium text-stone-700 transition hover:bg-stone-100"
            >
              <RefreshCcw className="h-4 w-4" />
              Refresh
            </button>
          </div>

          <nav className="mt-5 grid grid-cols-3 gap-2 rounded-[22px] bg-stone-100 p-1.5">
            {SECTIONS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setSection(item.id)}
                className={`rounded-[18px] px-3 py-2.5 text-sm font-medium transition ${
                  section === item.id ? "bg-white text-stone-950 shadow-sm" : "text-stone-500"
                }`}
              >
                {item.label}
              </button>
            ))}
          </nav>
        </header>

        {notice && <Banner tone="success">{notice}</Banner>}
        {error && <Banner tone="error">{error}</Banner>}

        {section === "telegram" && (
          <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
            <aside className="rounded-[28px] border border-stone-200 bg-white/88 p-4 shadow-[0_16px_40px_rgba(90,69,38,0.06)]">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-700">Connected bots</p>
                  <p className="mt-1 text-sm text-stone-500">{bots.length} saved locally</p>
                </div>
                <button
                  type="button"
                  onClick={startNewBot}
                  className="rounded-full bg-stone-950 px-3 py-2 text-xs font-semibold text-white"
                >
                  New
                </button>
              </div>

              <div className="mt-4 space-y-3">
                {isLoading && <p className="text-sm text-stone-500">Loading bot profiles...</p>}
                {!isLoading && !bots.length && (
                  <div className="rounded-[22px] border border-dashed border-stone-300 bg-stone-50 px-4 py-5 text-sm text-stone-500">
                    Paste a Telegram bot token below and hit connect. The token is stored encrypted on this laptop.
                  </div>
                )}
                {bots.map((bot) => (
                  <button
                    key={bot.id}
                    type="button"
                    onClick={() => chooseBot(bot)}
                    className={`w-full rounded-[22px] border px-4 py-4 text-left transition ${
                      selectedBotId === bot.id
                        ? "border-stone-950 bg-stone-950 text-white"
                        : "border-stone-200 bg-stone-50 text-stone-900 hover:bg-stone-100"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold">{bot.name}</p>
                        <p className={`mt-1 text-xs ${selectedBotId === bot.id ? "text-stone-300" : "text-stone-500"}`}>
                          {bot.username ? `@${bot.username}` : bot.displayName}
                        </p>
                      </div>
                      <span
                        className={`rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${
                          bot.webhook?.url ? "bg-emerald-500/15 text-emerald-600" : "bg-amber-500/15 text-amber-700"
                        }`}
                      >
                        {bot.webhook?.url ? "Webhook" : "Manual"}
                      </span>
                    </div>
                    <div className={`mt-3 text-xs ${selectedBotId === bot.id ? "text-stone-300" : "text-stone-500"}`}>
                      {bot.ollamaModel || "No model selected"} · {bot.knowledgePaths.length} paths · {bot.googleDriveLinks.length} drives
                    </div>
                  </button>
                ))}
              </div>
            </aside>

            <section className="rounded-[28px] border border-stone-200 bg-white/88 p-4 shadow-[0_16px_40px_rgba(90,69,38,0.06)] md:p-5">
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-700">Telegram commander</p>
                  <h2 className="mt-1 text-2xl font-semibold text-stone-950">
                    {selectedBot ? `Edit ${selectedBot.name}` : "Connect a new bot"}
                  </h2>
                </div>
                <div className="text-sm text-stone-500">
                  {selectedBot ? "Token can be replaced, but stays hidden once saved." : "Bot token stays out of source files."}
                </div>
              </div>

              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <Field
                  label="Bot name"
                  icon={<Bot className="h-4 w-4" />}
                  value={form.name}
                  onChange={(value) => setForm((current) => ({ ...current, name: value }))}
                  placeholder="Laptop Commander"
                />
                <Field
                  label={selectedBot ? "Replace token (optional)" : "Telegram bot token"}
                  icon={<KeyRound className="h-4 w-4" />}
                  value={form.token}
                  onChange={(value) => setForm((current) => ({ ...current, token: value }))}
                  placeholder="123456:ABC..."
                />
                <Field
                  label="Ollama base URL"
                  icon={<Sparkles className="h-4 w-4" />}
                  value={form.ollamaBaseUrl}
                  onChange={(value) => setForm((current) => ({ ...current, ollamaBaseUrl: value }))}
                  placeholder="http://127.0.0.1:11434"
                />
                <label className="rounded-[22px] border border-stone-200 bg-stone-50 px-4 py-3">
                  <span className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-stone-500">
                    <MessageCircle className="h-4 w-4" />
                    Ollama model
                  </span>
                  <select
                    value={form.ollamaModel}
                    onChange={(event) => setForm((current) => ({ ...current, ollamaModel: event.target.value }))}
                    className="w-full bg-transparent text-sm text-stone-800 outline-none"
                  >
                    <option value="">Select a model</option>
                    {models.map((model) => (
                      <option key={model.model} value={model.model}>
                        {model.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="mt-3">
                <TextareaField
                  label="System prompt"
                  value={form.systemPrompt}
                  onChange={(value) => setForm((current) => ({ ...current, systemPrompt: value }))}
                  placeholder="You are a Telegram task bot for this laptop. Prefer direct action, short updates, and safe file changes."
                  rows={4}
                />
              </div>

              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <TextareaField
                  label="Allowed local paths"
                  value={form.knowledgePaths}
                  onChange={(value) => setForm((current) => ({ ...current, knowledgePaths: value }))}
                  placeholder={"C:\\Users\\AlexT\\OneDrive\\Documents\\New project\nC:\\Users\\AlexT\\Downloads"}
                  rows={5}
                />
                <TextareaField
                  label="Google Drive roots"
                  value={form.googleDriveLinks}
                  onChange={(value) => setForm((current) => ({ ...current, googleDriveLinks: value }))}
                  placeholder={"https://drive.google.com/drive/folders/...\nhttps://drive.google.com/file/d/..."}
                  rows={5}
                />
              </div>

              <div className="mt-3 grid gap-3 md:grid-cols-[1fr_220px]">
                <TextareaField
                  label="Telegram commands"
                  value={form.commands}
                  onChange={(value) => setForm((current) => ({ ...current, commands: value }))}
                  placeholder={"/start - Introduce the bot\n/build - Build the current app\n/files - Show allowed file roots"}
                  rows={5}
                />
                <div className="space-y-3">
                  <Field
                    label="Test chat ID"
                    icon={<Send className="h-4 w-4" />}
                    value={form.testChatId}
                    onChange={(value) => setForm((current) => ({ ...current, testChatId: value }))}
                    placeholder="123456789"
                  />
                  <div className="rounded-[22px] border border-stone-200 bg-stone-50 px-4 py-4 text-xs leading-6 text-stone-500">
                    Use a personal chat ID or a group/channel ID where the bot has permission to post.
                  </div>
                </div>
              </div>

              <div className="mt-3">
                <TextareaField
                  label="Integration notes"
                  value={form.integrationNotes}
                  onChange={(value) => setForm((current) => ({ ...current, integrationNotes: value }))}
                  placeholder="What this bot should do, app repos it can modify, how cautious it should be, and later integrations to add."
                  rows={3}
                />
              </div>

              <div className="mt-5 flex flex-wrap gap-2">
                <ActionButton onClick={saveBot} busy={isSaving} icon={<Save className="h-4 w-4" />}>
                  {selectedBot ? "Save bot" : "Connect bot"}
                </ActionButton>
                <ActionButton onClick={applyCommands} busy={isApplyingCommands} secondary icon={<MessageCircle className="h-4 w-4" />}>
                  Apply commands
                </ActionButton>
                <ActionButton onClick={sendTestMessage} busy={isTesting} secondary icon={<Send className="h-4 w-4" />}>
                  Send test message
                </ActionButton>
                {selectedBot && (
                  <ActionButton onClick={removeBot} secondary icon={<Trash2 className="h-4 w-4" />}>
                    Remove
                  </ActionButton>
                )}
              </div>

              {selectedBot && (
                <div className="mt-5 grid gap-3 md:grid-cols-3">
                  <MiniStat label="Telegram" value={selectedBot.username ? `@${selectedBot.username}` : "Connected"} />
                  <MiniStat label="Webhook" value={selectedBot.webhook?.url ? "Active" : "Not set"} />
                  <MiniStat label="Pending updates" value={String(selectedBot.webhook?.pending_update_count ?? 0)} />
                </div>
              )}
            </section>
          </div>
        )}

        {section === "files" && (
          <section className="grid gap-4 md:grid-cols-2">
            <Card
              eyebrow="Laptop files"
              title="Work directly from local folders."
              body="Use the ingest workspace for PST files, folders, PDFs, screenshots, archives, and mixed evidence sets. This stays local to the machine."
              href="/ingest"
              cta="Open file ingest"
              icon={<FolderSearch className="h-5 w-5" />}
            />
            <Card
              eyebrow="Drive inputs"
              title="Start with pasted Google Drive links."
              body="The current local pipeline already accepts public Drive files and folder links. Your Telegram bot profiles can also store Drive roots for later agent wiring."
              href="/ingest"
              cta="Open Drive import"
              icon={<Sparkles className="h-5 w-5" />}
            />
          </section>
        )}

        {section === "site" && (
          <section className="grid gap-4 md:grid-cols-2">
            <Card
              eyebrow="Wix view"
              title="Open the slimmer site dashboard."
              body="Your Wix route is separated now so the landing screen stays lightweight on mobile. Use it when you want site context without crowding the Telegram workspace."
              href="/wix"
              cta="Open Wix command page"
              icon={<Globe className="h-5 w-5" />}
            />
            <div className="rounded-[28px] border border-stone-200 bg-white/88 p-5 shadow-[0_16px_40px_rgba(90,69,38,0.06)]">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-700">Next wiring step</p>
              <h2 className="mt-2 text-2xl font-semibold text-stone-950">Telegram runtime</h2>
              <p className="mt-3 text-sm leading-6 text-stone-600">
                The setup layer is ready for bot credentials, model choice, file roots, and Drive roots. The next build step is a background update runner so Telegram messages can trigger live local actions automatically.
              </p>
            </div>
          </section>
        )}
      </section>
    </main>
  );
}

function Banner({ tone, children }: { tone: "success" | "error"; children: React.ReactNode }) {
  return (
    <div
      className={`rounded-[22px] px-4 py-3 text-sm ${
        tone === "success" ? "border border-emerald-200 bg-emerald-50 text-emerald-800" : "border border-red-200 bg-red-50 text-red-800"
      }`}
    >
      {children}
    </div>
  );
}

function Field({
  label,
  icon,
  value,
  onChange,
  placeholder
}: {
  label: string;
  icon: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label className="rounded-[22px] border border-stone-200 bg-stone-50 px-4 py-3">
      <span className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-stone-500">
        {icon}
        {label}
      </span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full bg-transparent text-sm text-stone-800 outline-none placeholder:text-stone-400"
      />
    </label>
  );
}

function TextareaField({
  label,
  value,
  onChange,
  placeholder,
  rows
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  rows: number;
}) {
  return (
    <label className="block rounded-[22px] border border-stone-200 bg-stone-50 px-4 py-3">
      <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.16em] text-stone-500">{label}</span>
      <textarea
        rows={rows}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full resize-y bg-transparent text-sm leading-6 text-stone-800 outline-none placeholder:text-stone-400"
      />
    </label>
  );
}

function ActionButton({
  children,
  onClick,
  busy = false,
  secondary = false,
  icon
}: {
  children: React.ReactNode;
  onClick: () => void;
  busy?: boolean;
  secondary?: boolean;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={`inline-flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${
        secondary
          ? "border border-stone-300 bg-white text-stone-800 hover:bg-stone-50"
          : "bg-stone-950 text-white hover:bg-stone-800"
      }`}
    >
      {icon}
      {busy ? "Working..." : children}
    </button>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[22px] border border-stone-200 bg-stone-50 px-4 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-stone-500">{label}</p>
      <p className="mt-2 text-sm font-medium text-stone-900">{value}</p>
    </div>
  );
}

function Card({
  eyebrow,
  title,
  body,
  href,
  cta,
  icon
}: {
  eyebrow: string;
  title: string;
  body: string;
  href: string;
  cta: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="rounded-[28px] border border-stone-200 bg-white/88 p-5 shadow-[0_16px_40px_rgba(90,69,38,0.06)]">
      <div className="flex items-center gap-3">
        <div className="rounded-2xl bg-stone-950 p-3 text-amber-300">{icon}</div>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-700">{eyebrow}</p>
      </div>
      <h2 className="mt-4 text-2xl font-semibold text-stone-950">{title}</h2>
      <p className="mt-3 text-sm leading-6 text-stone-600">{body}</p>
      <Link
        href={href}
        className="mt-5 inline-flex items-center rounded-full bg-stone-950 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-stone-800"
      >
        {cta}
      </Link>
    </div>
  );
}
