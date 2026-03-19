const NOTION_VERSION = "2026-03-11";

function requireNotionToken() {
  const token = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || "";
  if (!token) {
    throw new Error("Notion is not configured yet. Add NOTION_API_KEY to .env.local.");
  }
  return token;
}

function requireManusKey() {
  const token = process.env.MANUS_API_KEY || "";
  if (!token) {
    throw new Error("Manus is not configured yet. Add MANUS_API_KEY to .env.local.");
  }
  return token;
}

async function notionRequest(endpoint, method = "GET", body) {
  const response = await fetch(`https://api.notion.com${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${requireNotionToken()}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message || `Notion request failed (${response.status})`);
  }
  return payload;
}

function normalizeNotionId(value) {
  return String(value || "").trim().replace(/-/g, "");
}

function paragraphBlocksFromText(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 20)
    .map((line) => ({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [
          {
            type: "text",
            text: {
              content: line.slice(0, 1900)
            }
          }
        ]
      }
    }));
}

async function notionSearch(query) {
  return notionRequest("/v1/search", "POST", {
    query,
    filter: {
      property: "object",
      value: "page"
    },
    page_size: 8
  });
}

async function notionRetrievePage(pageId) {
  return notionRequest(`/v1/pages/${normalizeNotionId(pageId)}`);
}

async function notionRetrieveBlockChildren(blockId) {
  return notionRequest(`/v1/blocks/${normalizeNotionId(blockId)}/children?page_size=25`);
}

async function notionAppendToPage(pageId, content) {
  return notionRequest(`/v1/blocks/${normalizeNotionId(pageId)}/children`, "PATCH", {
    children: paragraphBlocksFromText(content)
  });
}

async function notionCreatePage(parentPageId, title, content) {
  return notionRequest("/v1/pages", "POST", {
    parent: {
      page_id: normalizeNotionId(parentPageId)
    },
    properties: {
      title: {
        title: [
          {
            type: "text",
            text: {
              content: String(title || "Untitled").slice(0, 200)
            }
          }
        ]
      }
    },
    children: paragraphBlocksFromText(content)
  });
}

async function notionQueryDataSource(dataSourceId) {
  return notionRequest(`/v1/data_sources/${normalizeNotionId(dataSourceId)}/query`, "POST", {
    page_size: 10
  });
}

async function notionListUsers() {
  return notionRequest("/v1/users");
}

async function manusRequest(endpoint, method = "GET", body) {
  const response = await fetch(`https://api.manus.ai${endpoint}`, {
    method,
    headers: {
      API_KEY: requireManusKey(),
      "Content-Type": "application/json",
      accept: "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message || payload.error || `Manus request failed (${response.status})`);
  }
  return payload;
}

async function manusCreateTask(prompt) {
  const mode = process.env.MANUS_MODE || "fast";
  const agentProfile = process.env.MANUS_AGENT_PROFILE || "manus-1.6-lite";
  return manusRequest("/v1/tasks", "POST", {
    prompt,
    mode,
    agent_profile: agentProfile,
    hide_in_task_list: true
  });
}

async function manusCreateConnectedTask(prompt, connectors) {
  const mode = process.env.MANUS_MODE || "fast";
  const agentProfile = process.env.MANUS_AGENT_PROFILE || "manus-1.6-lite";
  return manusRequest("/v1/tasks", "POST", {
    prompt,
    mode,
    agent_profile: agentProfile,
    hide_in_task_list: true,
    connectors
  });
}

async function manusGetTask(taskId) {
  return manusRequest(`/v1/tasks/${String(taskId || "").trim()}`);
}

async function manusListTasks() {
  return manusRequest("/v1/tasks");
}

module.exports = {
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
};
