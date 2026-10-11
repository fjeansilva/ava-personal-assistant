import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createTelegramApi } from "./channels/telegram/bot-api.js";
import { readTelegramToken } from "./channels/telegram/settings.js";

const controller = new AbortController();
const stop = () => controller.abort();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

try {
  const api = createTelegramApi(readTelegramToken());
  const bot = await api.getMe(controller.signal);
  const webhook = await api.getWebhookInfo(controller.signal);
  if (webhook.url) throw new Error("This bot has a webhook configured. Identification requires a bot without a webhook.");
  const phrase = `ava-setup-${randomBytes(6).toString("hex")}`;
  console.log(`Stop any other polling process for this bot. Send this exact text in a private chat with @${bot.username}:\n\n${phrase}\n`);
  console.log("Use this helper with your new test bot. It acknowledges earlier updates while waiting, sends no replies, and changes no configuration.");
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]);
  let offset: number | undefined;
  while (!signal.aborted) {
    const updates = await api.getUpdates({ ...(offset === undefined ? {} : { offset }), timeout: 20, signal });
    const match = updates.find(({ message }) => message?.chat.type === "private"
      && message.from && !message.from.is_bot && message.text === phrase);
    if (match?.message?.from) {
      console.log(`Add this to your local .env:\nTELEGRAM_ALLOWED_USER_IDS=${match.message.from.id}`);
      break;
    }
    const last = updates.at(-1);
    if (last) offset = last.update_id + 1;
    await delay(500, undefined, { signal });
  }
} catch (error) {
  if (!controller.signal.aborted) {
    console.error(error instanceof Error && error.name !== "TimeoutError" ? error.message : "Identification timed out. Run the command again when ready.");
    process.exitCode = 1;
  }
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
