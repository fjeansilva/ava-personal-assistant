import { join } from "node:path";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";

export function createVoiceSessionManager(
  cwd: string,
  liveSessionId: string,
  agentDir = getAgentDir(),
): SessionManager {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(liveSessionId)) {
    throw new Error("Invalid Live session ID for voice session storage.");
  }

  const sessionDir = join(agentDir, "sessions", `ava-voice-${liveSessionId}`);
  const manager = SessionManager.create(cwd, sessionDir);
  manager.appendSessionInfo(`Ava voice: ${liveSessionId}`);
  return manager;
}
