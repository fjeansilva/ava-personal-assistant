import { runTerminal } from "./terminal.js";
import { createAvaSession } from "./config/runtime.js"

try {
  const avaSession = await createAvaSession();

  try {
    console.log("Ava terminal - powered by Pi.\n");

    await runTerminal(async ({ message, write, signal }) => {
      if (signal.aborted) return;

      const unsubscribe = avaSession.subscribe((event) => {
        if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "text_delta"
        ) {
          write(event.assistantMessageEvent.delta);
        }
      });

      const onAbort = () => {
        void avaSession.abort().catch((error) => {
          console.error("Cancellation failed:", error);
        });
      };

      signal.addEventListener("abort", onAbort, { once: true});

      try {
        await avaSession.prompt(message);
      } finally {
        signal.removeEventListener("abort", onAbort);
        unsubscribe();
      }

    });
  } finally {
    avaSession.dispose();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
