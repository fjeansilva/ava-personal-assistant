import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildSessionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { createVoiceSessionManager } from "../dist/agents/ava/voice-session.js";

function fixture(t) {
  const agentDir = mkdtempSync(join(tmpdir(), "ava-voice-session-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  return { agentDir, cwd: join(agentDir, "project") };
}

test("voice delegates persist in a named Pi file and can be reopened without a model call", (t) => {
  const { cwd, agentDir } = fixture(t);
  const manager = createVoiceSessionManager(cwd, "live_test", agentDir);
  const path = manager.getSessionFile();
  assert.equal(manager.isPersisted(), true);
  assert.equal(manager.getSessionDir(), join(agentDir, "sessions", "ava-voice-live_test"));
  assert.equal(manager.getSessionName(), "Ava voice: live_test");
  // Pi does not create a JSONL file for setup entries alone.
  assert.equal(existsSync(path), false);

  const message = { role: "user", content: "A synthetic voice request.", timestamp: 1 };
  manager.appendMessage(message);
  assert.equal(existsSync(path), true);
  const reply = {
    role: "assistant", content: [{ type: "text", text: "A synthetic reply." }],
    api: "openai-responses", provider: "openai", model: "test-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: 2,
  };
  manager.appendMessage(reply);

  const entries = readFileSync(path, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(entries[0].type, "session");
  assert.equal(entries[0].id, manager.getSessionId());
  assert.equal(entries[0].cwd, cwd);
  const reopened = SessionManager.open(path);
  assert.equal(reopened.getSessionName(), "Ava voice: live_test");
  assert.deepEqual(buildSessionContext(reopened.getEntries()).messages, [message, reply]);
});

test("new backend launches and different Live calls never overwrite or resume another history", (t) => {
  const { cwd, agentDir } = fixture(t);
  const first = createVoiceSessionManager(cwd, "live_first", agentDir);
  first.appendMessage({ role: "user", content: "Keep this request.", timestamp: 1 });
  const original = readFileSync(first.getSessionFile(), "utf8");
  const second = createVoiceSessionManager(cwd, "live_first", agentDir);
  const otherCall = createVoiceSessionManager(cwd, "live_other", agentDir);
  assert.notEqual(second.getSessionFile(), first.getSessionFile());
  assert.notEqual(otherCall.getSessionDir(), first.getSessionDir());
  for (const manager of [second, otherCall]) {
    assert.deepEqual(buildSessionContext(manager.getEntries()).messages, []);
  }
  second.appendMessage({ role: "user", content: "A new launch.", timestamp: 2 });
  assert.equal(readdirSync(first.getSessionDir()).length, 2);
  assert.equal(readFileSync(first.getSessionFile(), "utf8"), original);
});

test("invalid Live IDs cannot escape the voice storage directory", (t) => {
  const { cwd, agentDir } = fixture(t);
  for (const id of ["", "../other", "live/../../other", "live\\other", "live\nother", "x".repeat(257)]) {
    assert.throws(() => createVoiceSessionManager(cwd, id, agentDir), /Invalid Live session ID/);
  }
  assert.deepEqual(readdirSync(agentDir), []);
});
