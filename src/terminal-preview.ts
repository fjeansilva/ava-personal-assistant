import { runTerminal } from "./terminal.js";
import { modelConfig } from "./agents/ava/config.js";
import { createAvaResourceLoader } from "./agents/ava/resources.js";
import { createSession } from "./core/session.js";
import { createMessageHandler } from "./core/handler.js";

try {
  const cwd = process.cwd();
  const resourceLoader = await createAvaResourceLoader(cwd);

  const avaSession = await createSession(modelConfig, {
    cwd,
    resourceLoader,
  });

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
