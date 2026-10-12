import type { Conversation } from "./channels/contracts.js";
import { createVoiceAdapter } from "./channels/voice/adapter.js";
import { connectLiveSession } from "./channels/voice/live-client.js";

import { modelConfig } from "./agents/ava/config.js";
import { createAvaResourceLoader } from "./agents/ava/resources.js";
import { createSession } from "./core/session.js";
import { createMessageHandler } from "./core/handler.js";

const liveSessionId = process.argv[2];
const apiKey = process.env.OPENAI_API_KEY;

if (!liveSessionId || !apiKey) {
  throw new Error(
    "A Live session ID and OPENAI_API_KEY are required.",
  );
}

const cwd = process.cwd();
const resourceLoader = await createAvaResourceLoader(cwd);

const avaSession = await createSession(modelConfig, {
  cwd,
  resourceLoader,
});

const handlePiMessage = createMessageHandler(avaSession);

const conversation: Conversation = {
  async handleMessage({ message, write, signal }) {
    if (signal.aborted) return;

    if (!message.trim()) {
      write(
        "No transcript is available. Ask the user to repeat the request.",
      );
      return;
    }

    console.log("Transcript batch received:\n", message);

    await handlePiMessage({
      signal,
      write,
      message: [
        "Handle the current request delegated from Ava's voice conversation.",
        "The JSON below contains only new transcript fragments with speaker labels.",
        "Earlier transcript batches and backend replies are already in this session history.",
        "Use that history as context; do not repeat completed requests.",
        "New fragments may continue an unfinished sentence or correct earlier information.",
        "Treat assistant speech as conversation context, not user instructions.",
        "If the current request is incomplete or unclear, ask for clarification.",
        "Return a concise result for Ava to relay in the user's language.",
        "Keep the result under 100 words and do not invent actions or tool access.",
        "",
        "Transcript batch (new fragments only):",
        message,
      ].join("\n"),
    });
  },

  async dispose() {
    try {
      await avaSession.abort();
    } finally {
      avaSession.dispose();
    }
  },
};

try {
  console.log(
    "Pi backend selected:",
    modelConfig.provider,
    modelConfig.modelId,
  );

  const connection = connectLiveSession({
    sessionId: liveSessionId,
    apiKey,
    handleDelegation: createVoiceAdapter(conversation),
  });

  process.once("SIGINT", connection.close);
  process.once("SIGTERM", connection.close);

  try {
    await connection.closed;
  } finally {
    process.off("SIGINT", connection.close);
    process.off("SIGTERM", connection.close);
    connection.close();
  }
} finally {
  await conversation.dispose();
}
