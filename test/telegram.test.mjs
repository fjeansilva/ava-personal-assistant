import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { runTelegramChannel, splitTelegramText } from "../dist/channels/telegram/channel.js";
import { createTelegramApi, TelegramApiError } from "../dist/channels/telegram/bot-api.js";
import { readTelegramSettings } from "../dist/channels/telegram/settings.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function eventually(predicate) {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail("Expected condition was not reached.");
    await delay(5);
  }
}

function fixture(t, createConversation, overrides = {}) {
  const controller = new AbortController();
  const sent = [];
  const drafts = [];
  const polls = [];
  const errors = [];
  const batches = [];
  let wake;
  let id = 0;
  const api = {
    async getMe() { return { id: 1, username: "ava_test_bot" }; },
    async getWebhookInfo() { return { url: "" }; },
    async getUpdates(options) {
      polls.push(options.offset);
      while (!batches.length) {
        options.signal.throwIfAborted();
        await new Promise((resolve, reject) => {
          const finish = () => { options.signal.removeEventListener("abort", abort); resolve(); };
          const abort = () => { wake = undefined; reject(options.signal.reason); };
          wake = finish;
          options.signal.addEventListener("abort", abort, { once: true });
        });
      }
      return batches.shift();
    },
    async sendMessage(chatId, text, signal) { signal.throwIfAborted(); sent.push({ chatId, text }); },
    async sendMessageDraft(chatId, draftId, text, signal) { signal.throwIfAborted(); drafts.push({ chatId, draftId, text }); },
    ...overrides,
  };
  const running = runTelegramChannel({
    api, createConversation, allowedUserIds: new Set([7, 8]), signal: controller.signal,
    previewIntervalMs: 10, onError: (error) => errors.push(error),
  });
  t.after(async () => { controller.abort(); await running; });
  function push(...updates) {
    batches.push(updates);
    wake?.();
    wake = undefined;
  }
  function message(text, { userId = 7, chatId = 7, type = "private" } = {}) {
    return { update_id: ++id, message: { message_id: id, text, chat: { id: chatId, type }, from: { id: userId, is_bot: false } } };
  }
  return { controller, running, sent, drafts, polls, errors, push, message };
}

test("streams before completion, finalizes text, and reuses the same conversation", async (t) => {
  const gate = deferred();
  const inputs = [];
  const identities = [];
  const f = fixture(t, (identity) => {
    identities.push(identity);
    return {
      async handleMessage({ message, write }) {
        inputs.push(message);
        write("Hello ");
        if (message === "first") await gate.promise;
        write("world");
      },
      dispose() {},
    };
  });
  f.push(f.message("first"), f.message("second"));
  await eventually(() => f.drafts.some(({ text }) => text === "Hello "));
  assert.equal(f.sent.length, 0);
  assert.deepEqual(inputs, ["first"]);
  gate.resolve();
  await eventually(() => f.sent.length === 2);
  assert.deepEqual(inputs, ["first", "second"]);
  assert.equal(identities.length, 1);
  assert.deepEqual(identities[0], { channel: "telegram", conversationId: "7", userId: "7" });
  assert.deepEqual(f.sent.map(({ text }) => text), ["Hello world", "Hello world"]);
});

test("ignores other users and group chats before creating a conversation", async (t) => {
  let created = 0;
  const f = fixture(t, () => { created++; throw new Error("Unexpected conversation"); });
  f.push(f.message("outsider", { userId: 9 }), f.message("group", { type: "group" }), f.message("/start"));
  await eventually(() => f.sent.length === 1);
  assert.equal(created, 0);
  assert.match(f.sent[0].text, /Send a text message/);
});

test("cancel is processed during generation, clears the queue, and accepts a new request", async (t) => {
  const inputs = [];
  let aborted = false;
  const f = fixture(t, () => ({
    async handleMessage({ message, write, signal }) {
      inputs.push(message);
      if (message === "first") {
        await new Promise((resolve) => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
        write("This late output must be ignored");
      } else write("New response");
    },
    dispose() {},
  }));
  f.push(f.message("first"));
  await eventually(() => inputs.length === 1);
  f.push(f.message("pending"), f.message("/cancel"));
  await eventually(() => aborted && f.sent.some(({ text }) => /Cleared 1/.test(text)));
  f.push(f.message("after cancellation"));
  await eventually(() => f.sent.some(({ text }) => text === "New response"));
  assert.deepEqual(inputs, ["first", "after cancellation"]);
  assert.ok(!f.sent.some(({ text }) => text.includes("late output")));
});

test("keeps conversations isolated across chats", async (t) => {
  const identities = [];
  const f = fixture(t, (identity) => {
    identities.push(identity);
    return { async handleMessage({ write }) { write(identity.conversationId); }, dispose() {} };
  });
  f.push(f.message("one"), f.message("two", { userId: 8, chatId: 8 }));
  await eventually(() => f.sent.length === 2);
  assert.equal(identities.length, 2);
  assert.deepEqual(f.sent.sort((a, b) => a.chatId - b.chatId), [{ chatId: 7, text: "7" }, { chatId: 8, text: "8" }]);
});

test("reports a handler failure and handles the following message", async (t) => {
  const f = fixture(t, () => ({
    async handleMessage({ message, write }) { if (message === "fail") throw new Error("Private diagnostic"); write("Recovered"); },
    dispose() {},
  }));
  f.push(f.message("fail"), f.message("next"));
  await eventually(() => f.sent.length === 2);
  assert.match(f.sent[0].text, /response failed/);
  assert.equal(f.sent[1].text, "Recovered");
  assert.equal(f.errors.length, 1);
  assert.ok(!f.sent.some(({ text }) => text.includes("Private diagnostic")));
});

test("a preview failure still allows final delivery", async (t) => {
  const f = fixture(t, () => ({ async handleMessage({ write }) { write("Final response"); }, dispose() {} }), {
    async sendMessageDraft() { throw new Error("Draft unavailable"); },
  });
  f.push(f.message("hello"));
  await eventually(() => f.sent.length === 1);
  assert.equal(f.sent[0].text, "Final response");
  assert.equal(f.errors.length, 1);
});

test("failed delivery does not re-run the handler or automatically retry", async (t) => {
  let generated = 0;
  let deliveryAttempts = 0;
  const f = fixture(t, () => ({ async handleMessage({ write }) { generated++; write("Ready"); }, dispose() {} }), {
    async sendMessage() { deliveryAttempts++; throw new Error("Offline"); },
  });
  f.push(f.message("hello"));
  await eventually(() => f.errors.length === 1);
  assert.equal(generated, 1);
  assert.equal(deliveryAttempts, 1);
});

test("advances the update offset and ignores repeated updates", async (t) => {
  let handled = 0;
  const f = fixture(t, () => ({ async handleMessage({ write }) { handled++; write("Done"); }, dispose() {} }));
  const update = f.message("one");
  f.push(update, update);
  await eventually(() => f.sent.length === 1 && f.polls.length >= 2);
  assert.equal(handled, 1);
  assert.equal(f.polls[1], update.update_id + 1);
});

test("splits long output without breaking emoji and sends chunks in order", async (t) => {
  const text = "x".repeat(4095) + "😀" + "y".repeat(4100);
  const chunks = splitTelegramText(text);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.every((chunk) => chunk.length <= 4096 && chunk.isWellFormed()));
  const f = fixture(t, () => ({ async handleMessage({ write }) { write(text); }, dispose() {} }));
  f.push(f.message("long"));
  await eventually(() => f.sent.length === chunks.length);
  assert.deepEqual(f.sent.map(({ text }) => text), chunks);
});

test("shutdown aborts active work, skips queued work, and disposes the conversation once", async (t) => {
  let started = 0;
  let disposed = 0;
  let aborted = false;
  const f = fixture(t, () => ({
    async handleMessage({ signal }) {
      started++;
      await new Promise((resolve) => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
    },
    dispose() { disposed++; },
  }));
  f.push(f.message("active"), f.message("queued"));
  await eventually(() => started === 1);
  f.controller.abort();
  await f.running;
  assert.equal(aborted, true);
  assert.equal(started, 1);
  assert.equal(disposed, 1);
});

test("refuses an existing webhook without deleting it", async () => {
  let polled = false;
  await assert.rejects(runTelegramChannel({
    api: {
      async getMe() { return { id: 1, username: "test_bot" }; },
      async getWebhookInfo() { return { url: "https://example.org/webhook" }; },
      async getUpdates() { polled = true; return []; },
    },
    createConversation() { throw new Error("Not expected"); },
    allowedUserIds: new Set([7]), signal: new AbortController().signal,
  }), /webhook configured/);
  assert.equal(polled, false);
});

test("Telegram settings are independent from model settings and reject invalid IDs", () => {
  const settings = readTelegramSettings({ TELEGRAM_BOT_TOKEN: "123:test_token", TELEGRAM_ALLOWED_USER_IDS: "7,8" });
  assert.deepEqual([...settings.allowedUserIds], [7, 8]);
  for (const value of [undefined, "", "7,", "abc", "0", "-1", "9007199254740992"]) {
    assert.throws(() => readTelegramSettings({ TELEGRAM_BOT_TOKEN: "123:test", TELEGRAM_ALLOWED_USER_IDS: value }), /numeric Telegram user ID/);
  }
  assert.throws(() => readTelegramSettings({ TELEGRAM_BOT_TOKEN: "SECRET" }), (error) => !error.message.includes("SECRET"));
});

test("Bot API uses POST, requests message updates, and validates decoded updates", async () => {
  const calls = [];
  const api = createTelegramApi("123:test", async (url, init) => {
    calls.push({ url, init });
    return Response.json({ ok: true, result: [{ update_id: 2, message: { message_id: 1, chat: { id: 7, type: "private" }, from: { id: 7, is_bot: false }, text: "Hi" } }] });
  });
  const updates = await api.getUpdates({ offset: 2, timeout: 25, signal: new AbortController().signal });
  assert.equal(updates[0].message.text, "Hi");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { offset: 2, timeout: 25, allowed_updates: ["message"] });
  const bad = createTelegramApi("123:test", async () => Response.json({ ok: true, result: [{ update_id: "bad" }] }));
  await assert.rejects(bad.getUpdates({ timeout: 1, signal: new AbortController().signal }), /invalid response/);
});

test("Bot API preserves retry metadata but never exposes token-bearing errors", async () => {
  const limited = createTelegramApi("123:secret", async () => Response.json({ ok: false, error_code: 429, description: "123:secret", parameters: { retry_after: 5 } }, { status: 429 }));
  await assert.rejects(limited.getMe(new AbortController().signal), (error) => {
    assert.ok(error instanceof TelegramApiError);
    assert.equal(error.retryAfter, 5);
    assert.ok(!error.message.includes("secret"));
    return true;
  });
  const offline = createTelegramApi("123:secret", async () => { throw new Error("https://api.telegram.org/bot123:secret/getMe"); });
  await assert.rejects(offline.getMe(new AbortController().signal), (error) => !error.message.includes("secret"));
});
