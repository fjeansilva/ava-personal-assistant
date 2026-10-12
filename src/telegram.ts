import { createTelegramApi } from "./channels/telegram/bot-api.js";
import { runTelegramChannel } from "./channels/telegram/channel.js";
import { readTelegramSettings } from "./channels/telegram/settings.js";
import { join } from "node:path";
import {
  getAgentDir,
  SessionManager
} from "@earendil-works/pi-coding-agent";

import { modelConfig } from "./agents/ava/config.js";
import { createAvaResourceLoader } from "./agents/ava/resources.js";
import { createSession } from "./core/session.js";
import { createMessageHandler } from "./core/handler.js";

const controller = new AbortController();
const stop = () => controller.abort();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

try {
  const { token, allowedUserIds } = readTelegramSettings();
  console.log("Telegram channel. Ctrl+C stops the process.");
  await runTelegramChannel({
    api: createTelegramApi(token),
    allowedUserIds,
    signal: controller.signal,
    welcomeMessage: "Telegram channel. Send text to try streaming, or /cancel to stop and clear pending requests.",
    onError(error) {
      console.error(error instanceof Error ? error.message : "Telegram channel error.");
    },

    async createConversation({ conversationId }) {
      const cwd = process.cwd();

      const sessionDir = join(
        getAgentDir(),
        "sessions",
        `ava-telegram-${conversationId}`,
      );

      const resourceLoader = await createAvaResourceLoader(cwd);

      const sessionManager = SessionManager.continueRecent(
        cwd,
        sessionDir,
      );

      const session = await createSession(modelConfig, {
        cwd,
        resourceLoader,
        sessionManager,
      });

      console.log("Telegram session:", sessionManager.getSessionId());
      console.log("Session file:", sessionManager.getSessionFile());

      return {
        handleMessage: createMessageHandler(session),
        dispose: () => session.dispose(),
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
