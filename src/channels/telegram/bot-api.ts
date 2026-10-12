export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; is_bot: boolean };
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface PollOptions {
  offset?: number;
  timeout: number;
  signal: AbortSignal;
}

export interface TelegramApi {
  getMe(signal: AbortSignal): Promise<{ id: number; username: string }>;
  getWebhookInfo(signal: AbortSignal): Promise<{ url: string }>;
  getUpdates(options: PollOptions): Promise<TelegramUpdate[]>;
  sendMessage(chatId: number, text: string, signal: AbortSignal): Promise<void>;
  sendMessageDraft(chatId: number, draftId: number, text: string, signal: AbortSignal): Promise<void>;
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function invalidResponse(): never {
  throw new Error("Telegram returned an invalid response.");
}

function parseUpdate(value: unknown): TelegramUpdate {
  if (!record(value) || !integer(value.update_id)) return invalidResponse();
  const update: TelegramUpdate = { update_id: value.update_id };
  const message = value.message;
  if (message === undefined) return update;
  if (!record(message) || !integer(message.message_id) || !record(message.chat)
    || !integer(message.chat.id) || typeof message.chat.type !== "string") return invalidResponse();
  update.message = {
    message_id: message.message_id,
    chat: { id: message.chat.id, type: message.chat.type },
  };
  if (record(message.from) && integer(message.from.id) && typeof message.from.is_bot === "boolean") {
    update.message.from = { id: message.from.id, is_bot: message.from.is_bot };
  }
  if (typeof message.text === "string") update.message.text = message.text;
  return update;
}

export class TelegramApiError extends Error {
  constructor(readonly status: number, readonly retryAfter?: number) {
    super(`Telegram request failed (${status}).${retryAfter === undefined ? "" : ` Retry after ${retryAfter} seconds.`}`);
    this.name = "TelegramApiError";
  }
}

export function createTelegramApi(token: string, fetcher: Fetch = fetch): TelegramApi {
  async function request(method: string, body: object, signal: AbortSignal, timeoutMs = 15_000): Promise<unknown> {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    let response: Response;
    let payload: unknown;
    try {
      response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: requestSignal,
      });
      payload = await response.json();
    } catch {
      signal.throwIfAborted();
      // Never expose fetch errors: their URLs can contain the bot token.
      throw new Error("Telegram request could not be completed. Check the connection and restart if needed.");
    }
    if (!record(payload) || typeof payload.ok !== "boolean") return invalidResponse();
    if (!response.ok || !payload.ok) {
      const retry = record(payload.parameters) && integer(payload.parameters.retry_after)
        ? payload.parameters.retry_after : undefined;
      throw new TelegramApiError(integer(payload.error_code) ? payload.error_code : response.status, retry);
    }
    return payload.result;
  }

  return {
    async getMe(signal) {
      const value = await request("getMe", {}, signal);
      if (!record(value) || !integer(value.id) || typeof value.username !== "string") return invalidResponse();
      return { id: value.id, username: value.username };
    },
    async getWebhookInfo(signal) {
      const value = await request("getWebhookInfo", {}, signal);
      if (!record(value) || typeof value.url !== "string") return invalidResponse();
      return { url: value.url };
    },
    async getUpdates({ offset, timeout, signal }) {
      const value = await request("getUpdates", {
        ...(offset === undefined ? {} : { offset }),
        timeout,
        allowed_updates: ["message"],
      }, signal, (timeout + 10) * 1_000);
      if (!Array.isArray(value)) return invalidResponse();
      return value.map(parseUpdate);
    },
    async sendMessage(chatId, text, signal) {
      const value = await request("sendMessage", { chat_id: chatId, text }, signal);
      if (!record(value) || !integer(value.message_id)) return invalidResponse();
    },
    async sendMessageDraft(chatId, draftId, text, signal) {
      const value = await request("sendMessageDraft", { chat_id: chatId, draft_id: draftId, text }, signal);
      if (value !== true) return invalidResponse();
    },
  };
}
