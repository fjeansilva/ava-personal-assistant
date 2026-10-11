import { setTimeout as delay } from "node:timers/promises";
import type { Conversation, ConversationFactory } from "../contracts.js";
import type { TelegramApi, TelegramMessage } from "./bot-api.js";

export interface TelegramChannelOptions {
  api: TelegramApi;
  allowedUserIds: ReadonlySet<number>;
  createConversation: ConversationFactory;
  signal: AbortSignal;
  onError?: (error: unknown) => void;
  previewIntervalMs?: number;
  pollTimeoutSeconds?: number;
  welcomeMessage?: string;
}

interface ChatState {
  queue: string[];
  userId: number;
  conversation?: Conversation;
  running?: Promise<void>;
  active?: AbortController;
}

export function splitTelegramText(text: string, limit = 4096): string[] {
  if (!Number.isInteger(limit) || limit < 2) throw new Error("Text limit must be at least two characters.");
  const chunks: string[] = [];
  let chunk = "";
  // Count UTF-16 units conservatively while keeping complete Unicode characters.
  for (const character of text) {
    if (chunk.length + character.length > limit) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export async function runTelegramChannel({
  api, allowedUserIds, createConversation, signal,
  onError = () => {}, previewIntervalMs = 800, pollTimeoutSeconds = 25,
  welcomeMessage = "Send a text message, or use /cancel to stop and clear pending requests.",
}: TelegramChannelOptions): Promise<void> {
  if (!allowedUserIds.size) throw new Error("At least one allowed Telegram user is required.");
  if (previewIntervalMs < 1) throw new Error("Preview interval must be positive.");
  const lifetime = new AbortController();
  const channelSignal = AbortSignal.any([signal, lifetime.signal]);
  const chats = new Map<number, ChatState>();
  const notices = new Set<Promise<void>>();
  let offset: number | undefined;
  let nextDraftId = 1;

  function report(error: unknown) {
    try { onError(error); } catch { /* Reporting must not break cleanup. */ }
  }

  function notify(chatId: number, text: string) {
    const pending = api.sendMessage(chatId, text, channelSignal)
      .catch((error: unknown) => { if (!channelSignal.aborted) report(error); })
      .finally(() => { notices.delete(pending); });
    notices.add(pending);
  }

  async function reply(chatId: number, state: ChatState, message: string) {
    const controller = new AbortController();
    state.active = controller;
    const requestSignal = AbortSignal.any([channelSignal, controller.signal]);
    const stopPreview = new AbortController();
    const previewSignal = AbortSignal.any([requestSignal, stopPreview.signal]);
    const draftId = nextDraftId++;
    let text = "";
    let revision = 0;
    let acceptingText = true;
    let handlerFailed = false;

    // This pump sends at most one draft request at a time and coalesces deltas.
    const preview = (async () => {
      let sentRevision = -1;
      try {
        while (!previewSignal.aborted) {
          if (sentRevision !== revision) {
            sentRevision = revision;
            const tail = splitTelegramText(text).at(-1) ?? "";
            await api.sendMessageDraft(chatId, draftId, tail, previewSignal);
          }
          await delay(previewIntervalMs, undefined, { signal: previewSignal });
        }
      } catch (error) {
        // A failed preview does not discard the completed response.
        if (!previewSignal.aborted) report(error);
      }
    })();

    try {
      if (!state.conversation) {
        state.conversation = await createConversation({
          channel: "telegram",
          conversationId: String(chatId),
          userId: String(state.userId),
        });
      }
      requestSignal.throwIfAborted();
      await state.conversation.handleMessage({
        message,
        signal: requestSignal,
        write(delta) {
          if (!acceptingText || requestSignal.aborted) return;
          text += delta;
          revision++;
        },
      });
    } catch (error) {
      if (!requestSignal.aborted) {
        handlerFailed = true;
        report(error);
      }
    } finally {
      acceptingText = false;
      stopPreview.abort();
      await preview;
    }

    try {
      if (requestSignal.aborted) return;
      const response = handlerFailed
        ? "The response failed. Please try again."
        : text.trim() ? text : "No text was returned.";
      for (const chunk of splitTelegramText(response)) {
        requestSignal.throwIfAborted();
        await api.sendMessage(chatId, chunk, requestSignal);
      }
    } catch (error) {
      if (!requestSignal.aborted) report(error);
    } finally {
      delete state.active;
    }
  }

  function startWorker(chatId: number, state: ChatState) {
    if (state.running || channelSignal.aborted) return;
    state.running = (async () => {
      while (state.queue.length && !channelSignal.aborted) {
        const message = state.queue.shift();
        if (message !== undefined) await reply(chatId, state, message);
      }
    })().catch(report).finally(() => {
      delete state.running;
      if (state.queue.length && !channelSignal.aborted) startWorker(chatId, state);
    });
  }

  function dispatch(message: TelegramMessage, username: string) {
    const sender = message.from;
    if (message.chat.type !== "private" || !sender || sender.is_bot || !allowedUserIds.has(sender.id)) return;
    const text = message.text?.trim();
    if (!text) return;
    const chatId = message.chat.id;
    const command = /^\/([a-z]+)(?:@([a-z0-9_]+))?(?:\s|$)/i.exec(text);
    if (command?.[2] && command[2].toLowerCase() !== username.toLowerCase()) return;
    const name = command?.[1]?.toLowerCase();
    if (name === "start" || name === "help") {
      notify(chatId, welcomeMessage);
      return;
    }
    if (name === "cancel") {
      const state = chats.get(chatId);
      const queued = state?.queue.length ?? 0;
      const active = Boolean(state?.active);
      if (state) {
        state.queue.length = 0;
        state.active?.abort();
      }
      notify(chatId, active || queued
        ? `Stopped. Cleared ${queued} pending request(s).`
        : "There is no response in progress.");
      return;
    }
    if (text.startsWith("/")) {
      notify(chatId, "Available commands: /start, /help, /cancel.");
      return;
    }
    let state = chats.get(chatId);
    if (!state) {
      state = { queue: [], userId: sender.id };
      chats.set(chatId, state);
    }
    if (state.queue.length >= 20) {
      notify(chatId, "The message queue is full. Wait for a response or use /cancel.");
      return;
    }
    state.queue.push(text);
    startWorker(chatId, state);
  }

  try {
    if (channelSignal.aborted) return;
    const bot = await api.getMe(channelSignal);
    const webhook = await api.getWebhookInfo(channelSignal);
    if (webhook.url) throw new Error("This bot has a webhook configured. Use a separate bot or remove that webhook before polling.");
    while (!channelSignal.aborted) {
      const updates = await api.getUpdates({
        ...(offset === undefined ? {} : { offset }),
        timeout: pollTimeoutSeconds,
        signal: channelSignal,
      });
      for (const update of updates) {
        if (channelSignal.aborted) break;
        if (offset !== undefined && update.update_id < offset) continue;
        // Acknowledgement is not durable processing: pending work is in memory.
        offset = update.update_id + 1;
        if (update.message) dispatch(update.message, bot.username);
      }
    }
  } catch (error) {
    if (!channelSignal.aborted) throw error;
  } finally {
    lifetime.abort();
    for (const state of chats.values()) {
      state.queue.length = 0;
      state.active?.abort();
    }
    await Promise.allSettled([...chats.values()].flatMap((state) => state.running ? [state.running] : []));
    await Promise.allSettled(notices);
    for (const state of chats.values()) {
      try { await state.conversation?.dispose(); } catch (error) { report(error); }
    }
  }
}
