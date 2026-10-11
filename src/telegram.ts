import { setTimeout as delay } from "node:timers/promises";
import { createTelegramApi } from "./channels/telegram/bot-api.js";
import { runTelegramChannel } from "./channels/telegram/channel.js";
import { readTelegramSettings } from "./channels/telegram/settings.js";

const controller = new AbortController();
const stop = () => controller.abort();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

try {
  const { token, allowedUserIds } = readTelegramSettings();
  console.log("Telegram channel preview: simulated replies, no Pi or model calls. Ctrl+C stops the process.");
  await runTelegramChannel({
    api: createTelegramApi(token),
    allowedUserIds,
    signal: controller.signal,
    welcomeMessage: "Telegram channel preview: replies are simulated; no model is connected. Send text to try streaming, or /cancel to stop and clear pending requests.",
    onError(error) {
      console.error(error instanceof Error ? error.message : "Telegram channel error.");
    },
    // Replace this factory with your Pi-backed conversation when it is ready.
    createConversation() {
      return {
        async handleMessage({ message, write, signal }) {
          const response = `Simulated response. You sent: ${message}\n\nThe Telegram channel is working. Pi is not connected yet.`;
          const characters = Array.from(response);
          for (let index = 0; index < characters.length; index += 8) {
            await delay(150, undefined, { signal });
            write(characters.slice(index, index + 8).join(""));
          }
        },
        dispose() {},
      };
    },
  });
} catch (error) {
  if (!controller.signal.aborted) {
    console.error(error instanceof Error ? error.message : "Telegram channel failed.");
    process.exitCode = 1;
  }
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
