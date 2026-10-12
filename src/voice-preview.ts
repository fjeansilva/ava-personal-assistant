import type { Conversation } from "./channels/contracts.js";
import { createVoiceAdapter } from "./channels/voice/adapter.js";
import { connectLiveSession } from "./channels/voice/live-client.js";

const sessionId = process.argv[2];
const apiKey = process.env.OPENAI_API_KEY;

if (!sessionId || !apiKey) {
  throw new Error("A Live session ID and OPENAI_API_KEY are required.");
}

const conversation: Conversation = {
    async handleMessage({ message, write }) {
      console.log(
        "Transcript snapshot received:\n",
        message || "(empty)",
      );

      if (!message) {
        write(
          "The voice adapter is connected, " +
          "but no transcript was available for this delegation.",
        );
        return;
      }

      write("The simulated backend received the voice transcript. ");
      write("No actions were performed.");
    },

    dispose() {},
};

const connection = connectLiveSession({
  sessionId,
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
  await conversation.dispose();
}
