import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runTerminal } from "../dist/terminal.js";

function createStreams() {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => {
    text += chunk.toString();
  });
  return { input, output, text: () => text };
}

test("streams replies immediately and processes queued messages in order", async () => {
  const streams = createStreams();
  const messages = [];
  let releaseFirst;
  const firstReply = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted;
  const started = new Promise((resolve) => {
    firstStarted = resolve;
  });

  const running = runTerminal(async ({ message, write }) => {
    messages.push(message);
    write(`Reply to ${message}: `);
    if (message === "first") {
      firstStarted();
      await firstReply;
    }
    write("done");
  }, streams);

  streams.input.end("\n first \nsecond\n/exit\nignored\n");
  await started;
  assert.deepEqual(messages, ["first"]);
  assert.match(streams.text(), /Ava: Reply to first: /);
  assert.doesNotMatch(streams.text(), /done/);
  releaseFirst();
  await running;

  assert.deepEqual(messages, ["first", "second"]);
  assert.match(streams.text(), /Ava: Reply to first: done/);
  assert.match(streams.text(), /Ava: Reply to second: done/);
});

test("reports a handler error and accepts the next message", async () => {
  const streams = createStreams();
  const running = runTerminal(async ({ message, write }) => {
    if (message === "fail") throw new Error("Example failure");
    write("Recovered");
  }, streams);

  streams.input.end("fail\nretry\n/exit\n");
  await running;
  assert.match(streams.text(), /Error: Example failure/);
  assert.match(streams.text(), /Ava: Recovered/);
});

test("finishes a final message at end of input without requiring /exit", async () => {
  const streams = createStreams();
  const messages = [];
  const running = runTerminal(async ({ message, write }) => {
    messages.push(message);
    write("Finished");
  }, streams);

  streams.input.end("last message");
  await running;
  assert.deepEqual(messages, ["last message"]);
  assert.match(streams.text(), /Ava: Finished/);
});

test("interrupts an active handler and removes process signal listeners", async () => {
  const streams = createStreams();
  const originalSigint = process.listenerCount("SIGINT");
  const originalSigterm = process.listenerCount("SIGTERM");
  const messages = [];
  let interrupted = false;

  const running = runTerminal(async ({ message, signal }) => {
    messages.push(message);
    await new Promise((resolve) => {
      signal.addEventListener("abort", () => {
        interrupted = true;
        resolve();
      }, { once: true });
      process.emit("SIGINT");
    });
  }, streams);

  streams.input.end("first\nsecond\n");
  await running;
  assert.equal(interrupted, true);
  assert.deepEqual(messages, ["first"]);
  assert.equal(process.listenerCount("SIGINT"), originalSigint);
  assert.equal(process.listenerCount("SIGTERM"), originalSigterm);
});
