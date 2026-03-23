const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

function ollamaBaseUrl(bot) {
  return String(bot.ollamaBaseUrl || process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
}

const OLLAMA_MODEL_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || "8h";
const OLLAMA_GENERATE_TIMEOUT_MS = Number(process.env.OLLAMA_GENERATE_TIMEOUT_MS || 300000);
const OPENCLAW_COMMAND = process.platform === "win32" ? "openclaw.cmd" : "openclaw";
const OPENCLAW_CONFIG_PATH = path.join(process.env.USERPROFILE || "", ".openclaw", "openclaw.json");
const OPENCLAW_FALLBACK_MODELS = [
  process.env.OPENCLAW_MODEL || "anthropic/claude-sonnet-4-20250514",
  "anthropic/claude-sonnet-4-20250514",
  "anthropic/claude-opus-4-6"
].filter(Boolean);

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function execFileText(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      windowsHide: true,
      timeout: options.timeoutMs || 60000,
      maxBuffer: 1024 * 1024,
      ...options
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message || "").trim() || `Failed to run ${command}`));
        return;
      }
      resolve(String(stdout || "").trim());
    });
  });
}

async function execOpenClawText(args, options = {}) {
  if (process.platform !== "win32") {
    return execFileText(OPENCLAW_COMMAND, args, options);
  }

  const serialized = args.map((arg) => `'${String(arg).replace(/'/g, "''")}'`).join(", ");
  const script = [
    `$cmd = ${`'${OPENCLAW_COMMAND.replace(/'/g, "''")}'`}`,
    `& $cmd @(${serialized})`
  ].join("; ");
  return execFileText("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], options);
}

function configuredProfiles(bot) {
  const profiles = [
    {
      id: "ollama:local",
      provider: "ollama",
      profile: "local",
      label: "Ollama Local",
      configured: true,
      baseUrl: ollamaBaseUrl(bot),
      defaultModel: bot.ollamaModel || process.env.OLLAMA_MODEL || ""
    }
  ];

  const openAiProfiles = [
    {
      id: "openai:project1",
      provider: "openai",
      profile: "project1",
      label: "OpenAI Project 1",
      apiKey: process.env.OPENAI_PROJECT_KEY_1 || process.env.OPENAI_API_KEY_PRIMARY || ""
    },
    {
      id: "openai:project2",
      provider: "openai",
      profile: "project2",
      label: "OpenAI Project 2",
      apiKey: process.env.OPENAI_PROJECT_KEY_2 || process.env.OPENAI_API_KEY_SECONDARY || ""
    },
    {
      id: "openai:default",
      provider: "openai",
      profile: "default",
      label: "OpenAI Default",
      apiKey: process.env.OPENAI_API_KEY || ""
    }
  ];

  const cohereProfiles = [
    {
      id: "cohere:default",
      provider: "cohere",
      profile: "default",
      label: "Cohere Default",
      apiKey: process.env.COHERE_API_KEY || ""
    }
  ];

  const anthropicProfiles = [
    {
      id: "anthropic:default",
      provider: "anthropic",
      profile: "default",
      label: "Anthropic Default",
      apiKey: process.env.ANTHROPIC_API_KEY || ""
    },
    {
      id: "openclaw:local",
      provider: "openclaw",
      profile: "local",
      label: "OpenClaw Gateway",
      configured: Boolean(process.env.OPENCLAW_ENABLE === "1" || fs.existsSync(OPENCLAW_CONFIG_PATH)),
      defaultModel: process.env.OPENCLAW_MODEL || "anthropic/claude-sonnet-4-20250514"
    }
  ];

  const openRouterProfiles = [
    {
      id: "openrouter:default",
      provider: "openrouter",
      profile: "default",
      label: "OpenRouter Default",
      apiKey: process.env.OPENROUTER_API_KEY || "",
      defaultModel: process.env.OPENROUTER_DEFAULT_MODEL || "openrouter/auto"
    }
  ];

  for (const profile of [...openAiProfiles, ...cohereProfiles, ...anthropicProfiles, ...openRouterProfiles]) {
    if (profile.apiKey || profile.configured) {
      profiles.push({
        ...profile,
        configured: profile.configured !== false
      });
    }
  }

  return profiles;
}

function normalizeToken(value) {
  return String(value || "").trim().toLowerCase();
}

function preferredModelNames(provider) {
  if (provider === "openai") {
    return ["gpt-5-mini", "gpt-5-nano", "gpt-4.1-mini", "gpt-4o-mini", "o4-mini"];
  }
  if (provider === "cohere") {
    return ["command-r7b-12-2024", "command-r-plus-08-2024", "command-a-03-2025"];
  }
  if (provider === "anthropic") {
    return ["claude-3-5-haiku-latest", "claude-3-7-sonnet-latest", "claude-sonnet-4-20250514"];
  }
  if (provider === "openclaw") {
    return ["anthropic/claude-sonnet-4-20250514", "anthropic/claude-opus-4-6"];
  }
  if (provider === "openrouter") {
    return ["openrouter/auto", "anthropic/claude-3.5-haiku", "openai/gpt-4o-mini", "qwen/qwen-2.5-coder-32b-instruct"];
  }
  return [];
}

function isUsefulOpenAiModel(modelId) {
  const value = normalizeToken(modelId);
  if (!value) {
    return false;
  }
  if (
    value.includes("embedding") ||
    value.includes("moderation") ||
    value.includes("image") ||
    value.includes("tts") ||
    value.includes("realtime") ||
    value.includes("audio") ||
    value.includes("transcribe") ||
    value.includes("whisper") ||
    value.includes("omni")
  ) {
    return false;
  }
  return value.startsWith("gpt") || value.startsWith("o") || value.includes("codex") || value.startsWith("chatgpt");
}

function findProfile(bot, rawValue) {
  const profiles = configuredProfiles(bot);
  const token = normalizeToken(rawValue);
  if (!token) {
    return null;
  }

  return (
    profiles.find((profile) => normalizeToken(profile.id) === token) ||
    profiles.find((profile) => token === "openai1" && profile.id === "openai:project1") ||
    profiles.find((profile) => token === "openai2" && profile.id === "openai:project2") ||
    profiles.find((profile) => token === "claude" && profile.provider === "anthropic") ||
    profiles.find((profile) => token === "openclaw" && profile.provider === "openclaw") ||
    profiles.find((profile) => token === "openrouterauto" && profile.id === "openrouter:default") ||
    profiles.find((profile) => normalizeToken(profile.provider) === token) ||
    profiles.find((profile) => normalizeToken(`${profile.provider}${profile.profile}`) === token) ||
    profiles.find((profile) => normalizeToken(`${profile.provider}${profile.profile}`) === token.replace(/[^a-z0-9]/g, "")) ||
    profiles.find((profile) => normalizeToken(profile.label) === token) ||
    null
  );
}

function currentSelection(bot, override = {}) {
  const profiles = configuredProfiles(bot);
  const byOverride = override.profileId ? findProfile(bot, override.profileId) : null;
  const byBot =
    findProfile(bot, bot.aiProviderId || "") ||
    findProfile(bot, `${bot.modelProvider || ""}:${bot.providerProfile || ""}`) ||
    findProfile(bot, bot.modelProvider || "");
  const profile = byOverride || byBot || profiles[0];
  const model =
    override.model ||
    bot.modelName ||
    (profile.provider === "ollama" ? bot.ollamaModel || profile.defaultModel : profile.defaultModel || "");

  return {
    ...profile,
    model
  };
}

async function listModels(bot, override = {}) {
  const selection = currentSelection(bot, override);
  if (selection.provider === "ollama") {
    const response = await fetchWithTimeout(`${selection.baseUrl}/api/tags`, {}, 15000);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || "Could not reach Ollama.");
    }
    const models = Array.isArray(payload.models) ? payload.models.map((model) => model.name || model.model).filter(Boolean) : [];
    return {
      selection,
      models: models.sort()
    };
  }

  if (selection.provider === "openai") {
    const response = await fetchWithTimeout("https://api.openai.com/v1/models", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${selection.apiKey}`
      }
    }, 15000);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error?.message || payload.message || `OpenAI model listing failed (${response.status})`);
    }
    const models = (Array.isArray(payload.data) ? payload.data : [])
      .map((model) => model.id)
      .filter(isUsefulOpenAiModel)
      .sort();
    return { selection, models };
  }

  if (selection.provider === "cohere") {
    const response = await fetchWithTimeout("https://api.cohere.ai/v1/models?endpoint=chat&page_size=100", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${selection.apiKey}`,
        accept: "application/json"
      }
    }, 15000);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.message || payload.error || `Cohere model listing failed (${response.status})`);
    }
    const models = (Array.isArray(payload.models) ? payload.models : [])
      .filter((model) => !model.is_deprecated)
      .map((model) => model.name)
      .filter(Boolean)
      .sort();
    return { selection, models };
  }

  if (selection.provider === "anthropic") {
    const response = await fetchWithTimeout("https://api.anthropic.com/v1/models", {
      method: "GET",
      headers: {
        "x-api-key": selection.apiKey,
        "anthropic-version": "2023-06-01"
      }
    }, 15000);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error?.message || payload.message || `Anthropic model listing failed (${response.status})`);
    }
    const models = (Array.isArray(payload.data) ? payload.data : [])
      .map((model) => model.id)
      .filter(Boolean)
      .sort();
    return { selection, models };
  }

  if (selection.provider === "openclaw") {
    let models = [];
    try {
      const output = await execOpenClawText(["models", "status", "--plain"], { timeoutMs: 8000 });
      models = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      models = OPENCLAW_FALLBACK_MODELS.slice();
    }
    models = [...new Set(models.concat(OPENCLAW_FALLBACK_MODELS))];
    return { selection, models };
  }

  if (selection.provider === "openrouter") {
    const response = await fetchWithTimeout("https://openrouter.ai/api/v1/models", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${selection.apiKey}`,
        accept: "application/json"
      }
    }, 15000);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error?.message || payload.message || `OpenRouter model listing failed (${response.status})`);
    }
    const models = (Array.isArray(payload.data) ? payload.data : [])
      .map((model) => model.id)
      .filter(Boolean)
      .sort();
    return { selection, models };
  }

  throw new Error(`Unsupported provider: ${selection.provider}`);
}

function pickCheapestUsefulModel(provider, models) {
  const names = Array.isArray(models) ? models : [];
  for (const preferred of preferredModelNames(provider)) {
    if (names.includes(preferred)) {
      return preferred;
    }
  }
  return names[0] || "";
}

function extractOpenAiText(payload) {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (typeof part.text === "string" && part.text.trim()) {
        return part.text.trim();
      }
    }
  }
  return "";
}

function extractOpenClawText(payload) {
  if (!payload) {
    return "";
  }
  if (typeof payload === "string") {
    return payload.trim();
  }
  const payloads = Array.isArray(payload.payloads)
    ? payload.payloads
    : Array.isArray(payload.result?.payloads)
      ? payload.result.payloads
      : [];
  for (const entry of payloads) {
    if (typeof entry?.text === "string" && entry.text.trim()) {
      return entry.text.trim();
    }
  }
  const candidates = [
    payload.text,
    payload.response,
    payload.message,
    payload.output,
    payload.result,
    payload.reply && payload.reply.text,
    payload.data && payload.data.text
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return "";
}

async function generateText(bot, prompt, systemPrompt, override = {}) {
  let selection = currentSelection(bot, override);
  let models = [];

  if (!selection.model) {
    const modelListing = await listModels(bot, override);
    selection = {
      ...modelListing.selection,
      model: override.model || modelListing.selection.model || pickCheapestUsefulModel(modelListing.selection.provider, modelListing.models)
    };
    models = modelListing.models;
  }

  if (!selection.model) {
    if (selection.provider === "ollama") {
      const modelListing = await listModels(bot, override);
      models = modelListing.models;
      selection = {
        ...modelListing.selection,
        model: pickCheapestUsefulModel(modelListing.selection.provider, modelListing.models)
      };
    }
  }

  if (!selection.model) {
    throw new Error(`No model is configured for ${selection.label}. Use /models and /model to choose one.`);
  }

  if (selection.provider === "ollama") {
    const response = await fetchWithTimeout(`${selection.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: selection.model,
        system: systemPrompt || bot.systemPrompt || "",
        prompt,
        stream: false,
        keep_alive: OLLAMA_MODEL_KEEP_ALIVE
      })
    }, OLLAMA_GENERATE_TIMEOUT_MS);

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.response) {
      throw new Error(payload.error || "Ollama request failed.");
    }

    return {
      selection,
      text: String(payload.response).trim()
    };
  }

  if (selection.provider === "openai") {
    const input = [];
    if (systemPrompt || bot.systemPrompt) {
      input.push({
        role: "system",
        content: [{ type: "input_text", text: systemPrompt || bot.systemPrompt || "" }]
      });
    }
    input.push({
      role: "user",
      content: [{ type: "input_text", text: prompt }]
    });

    const response = await fetchWithTimeout("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${selection.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: selection.model,
        input,
        max_output_tokens: 1800
      })
    }, 45000);

    const payload = await response.json().catch(() => ({}));
    const text = extractOpenAiText(payload);
    if (!response.ok || !text) {
      throw new Error(payload.error?.message || payload.message || "OpenAI request failed.");
    }

    return {
      selection,
      text
    };
  }

  if (selection.provider === "cohere") {
    const messages = [];
    if (systemPrompt || bot.systemPrompt) {
      messages.push({
        role: "system",
        content: systemPrompt || bot.systemPrompt || ""
      });
    }
    messages.push({
      role: "user",
      content: prompt
    });

    const response = await fetchWithTimeout("https://api.cohere.ai/v2/chat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${selection.apiKey}`,
        "Content-Type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({
        model: selection.model,
        messages,
        max_tokens: 1400
      })
    }, 45000);

    const payload = await response.json().catch(() => ({}));
    const text = payload?.message?.content?.[0]?.text || "";
    if (!response.ok || !text) {
      throw new Error(payload.message || payload.error || "Cohere request failed.");
    }

    return {
      selection,
      text: String(text).trim()
    };
  }

  if (selection.provider === "anthropic") {
    const response = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": selection.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: selection.model,
        max_tokens: 1600,
        system: systemPrompt || bot.systemPrompt || "",
        messages: [
          {
            role: "user",
            content: prompt
          }
        ]
      })
    }, 45000);

    const payload = await response.json().catch(() => ({}));
    const text = (Array.isArray(payload.content) ? payload.content : [])
      .filter((item) => item.type === "text" && item.text)
      .map((item) => item.text)
      .join("\n")
      .trim();
    if (!response.ok || !text) {
      throw new Error(payload.error?.message || payload.message || "Anthropic request failed.");
    }

    return {
      selection,
      text
    };
  }

  if (selection.provider === "openclaw") {
    const rules = String(systemPrompt || bot.systemPrompt || "").trim();
    const combinedPrompt = rules
      ? `${prompt}\n\nFollow these output rules:\n${rules}`
      : prompt;
    const sessionId = override.sessionId || `telegram-${bot.id || bot.name || "bot"}`;
    const raw = await execOpenClawText([
      "agent",
      "--json",
      "--session-id",
      sessionId,
      "--thinking",
      "off",
      "--message",
      combinedPrompt
    ], { timeoutMs: 60000 });

    let text = "";
    try {
      text = extractOpenClawText(JSON.parse(raw));
    } catch {
      text = raw.trim();
    }
    if (!text) {
      throw new Error("OpenClaw request failed.");
    }

    return {
      selection,
      text
    };
  }

  if (selection.provider === "openrouter") {
    const messages = [];
    if (systemPrompt || bot.systemPrompt) {
      messages.push({
        role: "system",
        content: systemPrompt || bot.systemPrompt || ""
      });
    }
    messages.push({
      role: "user",
      content: prompt
    });

    const response = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${selection.apiKey}`,
        "Content-Type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({
        model: selection.model,
        messages,
        max_tokens: 1600
      })
    }, 45000);

    const payload = await response.json().catch(() => ({}));
    const text = payload?.choices?.[0]?.message?.content || "";
    if (!response.ok || !text) {
      throw new Error(payload.error?.message || payload.message || "OpenRouter request failed.");
    }

    return {
      selection,
      text: String(text).trim()
    };
  }

  throw new Error(`Unsupported provider: ${selection.provider}`);
}

function describeProfiles(bot) {
  const selection = currentSelection(bot);
  return configuredProfiles(bot).map((profile) => ({
    ...profile,
    active: profile.id === selection.id
  }));
}

module.exports = {
  configuredProfiles,
  currentSelection,
  describeProfiles,
  findProfile,
  generateText,
  listModels,
  pickCheapestUsefulModel
};
