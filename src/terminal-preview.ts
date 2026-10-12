import { runTerminal } from "./terminal.js";
import { createAvaSession } from "./config/runtime.js"
import { createMessageHandler } from "./core/handler.js";

try {
  const avaSession = await createAvaSession();

  try {
    console.log("Ava terminal - powered by Pi.\n");
    const handleMessage = createMessageHandler(avaSession);
    await runTerminal(handleMessage);
  } finally {
    avaSession.dispose();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
