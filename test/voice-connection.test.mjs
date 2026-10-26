import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { connectLiveSession } from "../dist/channels/voice/live-client.js";

class FakeSocket extends EventEmitter {
  readyState = WebSocket.CONNECTING;
  sent = [];
  send(text, callback) { this.sent.push(JSON.parse(text)); callback(); }
  open() { this.readyState = WebSocket.OPEN; this.emit("open"); }
  receive(event) { this.emit("message", Buffer.from(JSON.stringify(event))); }
  close() {
    const connecting = this.readyState === WebSocket.CONNECTING;
    this.readyState = WebSocket.CLOSED;
    if (connecting) this.emit("error", new Error("Closed before connection was established"));
    this.emit("close");
  }
  http(statusCode, headers = {}) {
    let destroyed = false;
    this.emit("unexpected-response", {}, { statusCode, headers, destroy() { destroyed = true; } });
    assert.equal(destroyed, true);
  }
}

function fixture(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const logs = t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  const sockets = [];
  const requests = [];
  const connection = connectLiveSession({
    sessionId: "live_test", apiKey: "test-key",
    createSocket(url, options) {
      assert.equal(url, "wss://api.openai.com/v1/live/sessions/live_test/attach");
      assert.equal(options.headers.Authorization, "Bearer test-key");
      assert.equal(options.handshakeTimeout, 10_000);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    async handleDelegation(request) {
      requests.push(request);
      return { delegationId: request.delegationId, text: "Connected." };
    },
  });
  t.after(async () => { connection.close(); await connection.closed.catch(() => {}); });
  async function tick(ms) { t.mock.timers.tick(ms); await setImmediate(); }
  return { connection, sockets, requests, tick, logs };
}

test("a 503 handshake retries and the replacement connection processes one delegation", async (t) => {
  const f = fixture(t);
  let closed = false;
  f.connection.closed.finally(() => { closed = true; });
  f.sockets[0].http(503);
  assert.equal(closed, false);
  await f.tick(999);
  assert.equal(f.sockets.length, 1);
  await f.tick(1);
  const socket = f.sockets[1];
  socket.open();
  // Late events from a retired socket cannot close or feed the replacement.
  f.sockets[0].emit("error", new Error("Late failure"));
  f.sockets[0].receive({ type: "session.closed" });
  socket.receive({ type: "session.input_transcript.delta", delta: "A request", start_ms: 0, end_ms: 1 });
  socket.receive({ type: "session.delegation.created", delegation: { id: "one", target: "client" }, offset_ms: 1 });
  await f.tick(800);
  assert.equal(f.requests.length, 1);
  assert.equal(socket.sent[0].delegation_id, "one");
  assert.equal(socket.sent[0].content, "Connected.");
  assert.equal(closed, false);
  assert.equal(f.logs.mock.calls.filter(({ arguments: args }) => args[0].startsWith("Voice backend attached")).length, 1);
});

test("transient HTTP failures stop after four attempts and leave no retry timer", async (t) => {
  const f = fixture(t);
  const rejected = assert.rejects(f.connection.closed, /HTTP 503.*4 attempt/);
  for (const [i, delay] of [1_000, 2_000, 4_000].entries()) {
    f.sockets[i].http([502, 503, 504][i]);
    await f.tick(delay - 1);
    assert.equal(f.sockets.length, i + 1);
    await f.tick(1);
  }
  f.sockets[3].http(503);
  await rejected;
  await f.tick(60_000);
  assert.equal(f.sockets.length, 4);
  assert.equal(f.requests.length, 0);
});

test("authentication and unavailable-session HTTP responses fail without retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const status of [400, 401, 403, 404, 410]) {
    let attempts = 0;
    const socket = new FakeSocket();
    const connection = connectLiveSession({
      sessionId: "live_test", apiKey: "test-key",
      createSocket: () => { attempts++; return socket; },
      handleDelegation: async () => assert.fail("No delegation expected"),
    });
    const rejected = assert.rejects(connection.closed, new RegExp(`HTTP ${status}`));
    socket.http(status);
    await rejected;
    t.mock.timers.tick(60_000);
    assert.equal(attempts, 1);
    connection.close();
  }
});

test("Retry-After is respected and excessive server waits terminate the local attempt", async (t) => {
  const f = fixture(t);
  const rejected = assert.rejects(f.connection.closed, /HTTP 503/);
  f.sockets[0].http(429, { "retry-after": "3" });
  await f.tick(2_999);
  assert.equal(f.sockets.length, 1);
  await f.tick(1);
  assert.equal(f.sockets.length, 2);
  f.sockets[1].http(503, { "retry-after": "120" });
  await rejected;
  await f.tick(120_000);
  assert.equal(f.sockets.length, 2);
});

test("closing during retry cancels the timer and settles the connection", async (t) => {
  const f = fixture(t);
  f.sockets[0].http(503);
  f.connection.close();
  await f.connection.closed;
  await f.tick(60_000);
  assert.equal(f.sockets.length, 1);
});

test("closing during the handshake consumes the socket error without rejecting shutdown", async (t) => {
  const f = fixture(t);
  f.connection.close();
  await f.connection.closed;
  await f.tick(60_000);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.sockets[0].readyState, WebSocket.CLOSED);
});

test("an established connection error stops without reconnecting or replaying work", async (t) => {
  const f = fixture(t);
  f.sockets[0].open();
  const rejected = assert.rejects(f.connection.closed, /Disconnected/);
  f.sockets[0].emit("error", new Error("Disconnected"));
  await rejected;
  await f.tick(60_000);
  assert.equal(f.sockets.length, 1);
});

test("synchronous socket creation errors become a rejected connection", async () => {
  const connection = connectLiveSession({
    sessionId: "live_test", apiKey: "test-key",
    createSocket() { throw new Error("Invalid configuration"); },
    handleDelegation: async () => assert.fail("No delegation expected"),
  });
  await assert.rejects(connection.closed, /Could not start the GPT-Live connection/);
  connection.close();
});

test("real ws recovers from a loopback HTTP 503 followed by a successful upgrade", async (t) => {
  // No OpenAI request, credential, audio, or model is involved.
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "log", () => {});
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  let attempts = 0;
  server.on("upgrade", (request, socket, head) => {
    if (++attempts === 1) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    } else {
      wss.handleUpgrade(request, socket, head, (client) => {
        client.send(JSON.stringify({ type: "session.closed" }));
      });
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const connection = connectLiveSession({
    sessionId: "live_test", apiKey: "test-key",
    createSocket: () => new WebSocket(`ws://127.0.0.1:${server.address().port}`),
    handleDelegation: async () => assert.fail("No delegation expected"),
  });
  t.after(async () => {
    connection.close();
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  });
  await connection.closed;
  assert.equal(attempts, 2);
});
