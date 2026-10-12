import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { createVoiceAdapter } from "../dist/channels/voice/adapter.js";
import { connectLiveSession } from "../dist/channels/voice/live-client.js";
import { createTranscriptBuffer } from "../dist/channels/voice/transcript.js";

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent = [];

  receive(event) { this.emit("message", Buffer.from(JSON.stringify(event))); }
  send(text, callback) { this.sent.push(JSON.parse(text)); callback(); }
  close() { this.readyState = 3; this.emit("close"); }
}

function fixture(t, handleMessage = async ({ write }) => write("Simulated reply.")) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const log = t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "error", () => {});
  const socket = new FakeSocket();
  const requests = [];
  const handle = createVoiceAdapter({ handleMessage, dispose() {} });
  const connection = connectLiveSession({
    sessionId: "local-test",
    apiKey: "not-a-real-key",
    createSocket: () => socket,
    async handleDelegation(request) {
      requests.push(request);
      return handle(request);
    },
  });
  t.after(async () => { connection.close(); await connection.closed.catch(() => {}); });

  function fragment(text, startMs, endMs, speaker = "user") {
    socket.receive({
      type: speaker === "user" ? "session.input_transcript.delta" : "session.output_transcript.delta",
      delta: text, start_ms: startMs, end_ms: endMs,
    });
  }
  function delegate(id, offsetMs = 100) {
    socket.receive({ type: "session.delegation.created", delegation: { id, target: "client" }, offset_ms: offsetMs });
  }
  async function tick(ms) { t.mock.timers.tick(ms); await setImmediate(); }
  return { socket, requests, connection, fragment, delegate, tick, log };
}

function texts(request) {
  return JSON.parse(request.message).fragments.map(({ text }) => text);
}

test("collects both speakers and the request suffix after delegation, preserving spaces", async (t) => {
  const f = fixture(t);
  f.fragment("Please use this", 0, 100);
  f.delegate("first");
  await f.tick(500);
  f.fragment(" context", 100, 200);
  await f.tick(799);
  f.fragment(" I will check.", 200, 300, "assistant");
  assert.equal(f.requests.length, 0);
  await f.tick(1);

  const snapshot = JSON.parse(f.requests[0].message);
  assert.equal(snapshot.delegationOffsetMs, 100);
  assert.deepEqual(snapshot.fragments.map(({ speaker }) => speaker), ["user", "user", "assistant"]);
  assert.deepEqual(texts(f.requests[0]), ["Please use this", " context", " I will check."]);
  assert.ok(f.log.mock.calls.some(({ arguments: args }) =>
    args[0] === "[transcript:assistant] 200-300 ms" && args[1] === '" I will check."'));
  assert.equal(f.socket.sent[0].type, "session.commentary.append");
  assert.equal(f.socket.sent[0].delegation_id, "first");
  assert.equal(f.socket.sent[0].content, "Simulated reply.");
  await f.tick(5_000);
  assert.equal(f.requests.length, 1);
});

test("caps collection at two seconds even when user fragments keep arriving", async (t) => {
  const f = fixture(t);
  f.delegate("bounded");
  for (let i = 0; i < 3; i++) {
    await f.tick(500);
    f.fragment(" more", i * 100, (i + 1) * 100);
  }
  await f.tick(499);
  f.fragment(" text", 300, 400);
  assert.equal(f.requests.length, 0);
  await f.tick(1);
  assert.equal(f.requests.length, 1);
  assert.ok(f.log.mock.calls.some(({ arguments: args }) => args[2] === "max_wait"));
  await f.tick(5_000);
  assert.equal(f.requests.length, 1);
});

test("a new delegation freezes the previous one and each result keeps its identity", async (t) => {
  const f = fixture(t);
  f.fragment("First request", 0, 100);
  f.delegate("first");
  await f.tick(200);
  f.delegate("second", 200);
  f.fragment(" Second request", 200, 300);
  await setImmediate();
  assert.deepEqual(f.requests.map(({ delegationId }) => delegationId), ["first"]);
  assert.deepEqual(texts(f.requests[0]), ["First request"]);
  await f.tick(800);
  assert.deepEqual(f.socket.sent.map(({ delegation_id }) => delegation_id), ["first", "second"]);
  assert.deepEqual(texts(f.requests[1]), [" Second request"]);
  await f.tick(5_000);
  assert.equal(f.requests.length, 2);
});

test("queued batches stay disjoint and later fragments belong to the next delegation", async (t) => {
  const gate = Promise.withResolvers();
  let calls = 0;
  const f = fixture(t, async ({ write }) => {
    if (++calls === 1) await gate.promise;
    write("Done.");
  });
  f.fragment("Initial context", 0, 100);
  f.delegate("first");
  await f.tick(800);
  f.delegate("second", 200);
  f.fragment(" Collected suffix", 200, 300);
  await f.tick(800);
  f.fragment(" Too late for second", 300, 400);
  f.delegate("third", 400);
  await f.tick(800);
  f.fragment(" Too late for third", 400, 500);
  assert.equal(f.requests.length, 1);
  gate.resolve();
  await setImmediate();
  assert.equal(f.requests.length, 3);
  assert.deepEqual(texts(f.requests[0]), ["Initial context"]);
  assert.deepEqual(texts(f.requests[1]), [" Collected suffix"]);
  assert.deepEqual(texts(f.requests[2]), [" Too late for second"]);
  assert.deepEqual(f.socket.sent.map(({ delegation_id }) => delegation_id), ["first", "second", "third"]);
  f.delegate("fourth", 500);
  await f.tick(800);
  assert.deepEqual(texts(f.requests[3]), [" Too late for third"]);
});

test("late fragments with older or identical timestamps enter the next batch", async (t) => {
  const f = fixture(t);
  f.fragment("Initial request", 100, 200);
  f.delegate("first", 200);
  await f.tick(800);

  // Arrival order determines batch membership, not an audio-time watermark.
  f.fragment(" Earlier audio arriving late", 0, 50);
  f.fragment(" Same interval arriving late", 100, 200, "assistant");
  f.delegate("second", 200);
  await f.tick(800);
  assert.deepEqual(texts(f.requests[1]), [" Earlier audio arriving late", " Same interval arriving late"]);
  assert.deepEqual(texts(f.requests[0]), ["Initial request"]);
});

test("a delegation without new fragments receives an empty batch instead of old context", async (t) => {
  const f = fixture(t);
  f.fragment("Use once", 0, 100);
  f.delegate("first");
  await f.tick(800);
  f.delegate("empty", 200);
  await f.tick(800);
  assert.equal(f.requests[1].message, "");

  f.fragment(" New request", 200, 300);
  f.delegate("third", 300);
  await f.tick(800);
  assert.deepEqual(texts(f.requests[2]), [" New request"]);
});

for (const cause of ["local close", "remote close", "socket error"]) {
  test(`discards pending collection on ${cause}`, async (t) => {
    const f = fixture(t);
    f.fragment("Unfinished", 0, 100);
    f.delegate("pending");
    if (cause === "socket error") {
      const rejected = assert.rejects(f.connection.closed, /Disconnected/);
      f.socket.emit("error", new Error("Disconnected"));
      await rejected;
    } else {
      if (cause === "local close") f.connection.close();
      else f.socket.close();
      await f.connection.closed;
    }
    // Events buffered by the transport after shutdown must not start work.
    f.fragment(" Late input", 100, 200);
    f.delegate("after-close");
    await f.tick(5_000);
    assert.equal(f.requests.length, 0);
    assert.equal(f.socket.sent.length, 0);
  });
}

test("shutdown aborts active work and skips frozen queued delegations", async (t) => {
  const gate = Promise.withResolvers();
  const f = fixture(t, async ({ write }) => { await gate.promise; write("Late reply."); });
  f.fragment("Context", 0, 100);
  f.delegate("active");
  await f.tick(800);
  f.delegate("queued");
  await f.tick(800);
  f.connection.close();
  assert.equal(f.requests[0].signal.aborted, true);
  gate.resolve();
  await setImmediate();
  assert.equal(f.requests.length, 1);
  assert.equal(f.socket.sent.length, 0);
});

test("invalid events cannot extend collection or enter the transcript", async (t) => {
  const f = fixture(t);
  f.fragment("Valid", 0, 100);
  f.delegate("valid");
  await f.tick(700);
  f.socket.emit("message", Buffer.from("not JSON"));
  for (const event of [null, [], 42, { type: "session.delegation.created", delegation: 7 }]) {
    f.socket.receive(event);
  }
  f.fragment("Invalid", 300, 200);
  f.fragment("Invalid timestamp", -1, 0);
  f.fragment(123, 100, 200);
  f.delegate("bad-offset", -1);
  f.socket.receive({ type: "session.delegation.created", delegation: { id: "server", target: "server" }, offset_ms: 100 });
  await f.tick(100);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(texts(f.requests[0]), ["Valid"]);
});

test("a failed handler does not replay its batch or block the next request", async (t) => {
  let calls = 0;
  const f = fixture(t, async ({ write }) => {
    if (++calls === 1) throw new Error("Simulated failure");
    write("Recovered.");
  });
  f.fragment("First attempt", 0, 100);
  f.delegate("fails");
  await f.tick(800);
  f.fragment("Next request", 100, 200);
  f.delegate("recovers");
  await f.tick(800);
  assert.equal(f.requests.length, 2);
  assert.equal(f.socket.sent.length, 1);
  assert.equal(f.socket.sent[0].delegation_id, "recovers");
  assert.deepEqual(texts(f.requests[0]), ["First attempt"]);
  assert.deepEqual(texts(f.requests[1]), ["Next request"]);
});

test("taking a snapshot drains pending fragments without changing previous batches", () => {
  const buffer = createTranscriptBuffer();
  assert.equal(buffer.takeSnapshot(100), "");
  const fragment = { speaker: "user", text: " suffix", startMs: 100, endMs: 200 };
  buffer.append(fragment);
  fragment.text = "Changed outside the buffer";
  buffer.append({ speaker: "assistant", text: "Hello", startMs: 0, endMs: 50 });
  const snapshot = buffer.takeSnapshot(100);
  assert.equal(buffer.takeSnapshot(100), "");
  buffer.append({ speaker: "user", text: "Later", startMs: 200, endMs: 300 });
  assert.deepEqual(JSON.parse(snapshot).fragments.map(({ text }) => text), ["Hello", " suffix"]);
  assert.deepEqual(JSON.parse(buffer.takeSnapshot(300)).fragments.map(({ text }) => text), ["Later"]);
  assert.equal(buffer.takeSnapshot(300), "");
});
