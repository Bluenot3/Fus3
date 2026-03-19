type TelegramApiResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
};

export type TelegramBotIdentity = {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
  can_join_groups?: boolean;
  can_read_all_group_messages?: boolean;
  supports_inline_queries?: boolean;
};

export type TelegramWebhookInfo = {
  url: string;
  pending_update_count: number;
  last_error_message?: string;
  max_connections?: number;
  allowed_updates?: string[];
};

export type TelegramCommand = {
  command: string;
  description: string;
};

async function callTelegram<T>(token: string, method: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store"
  });

  const payload = (await response.json()) as TelegramApiResponse<T>;

  if (!response.ok || !payload.ok || payload.result === undefined) {
    throw new Error(payload.description || `Telegram request failed for ${method}`);
  }

  return payload.result;
}

export async function getTelegramBotIdentity(token: string) {
  return callTelegram<TelegramBotIdentity>(token, "getMe");
}

export async function getTelegramWebhookInfo(token: string) {
  return callTelegram<TelegramWebhookInfo>(token, "getWebhookInfo");
}

export async function sendTelegramMessage(token: string, chatId: string, text: string) {
  return callTelegram(token, "sendMessage", {
    chat_id: chatId,
    text
  });
}

export async function setTelegramCommands(token: string, commands: TelegramCommand[]) {
  return callTelegram<boolean>(token, "setMyCommands", {
    commands
  });
}
