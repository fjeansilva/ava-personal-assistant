import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { VoiceRequest, VoiceResult } from "./adapter.js";
import { createTranscriptBuffer } from "./transcript.js";

type LiveSocket = Pick<WebSocket, "on" | "once" | "send" | "close" | "readyState">;

interface LiveClientOptions {
  sessionId: string;
  apiKey: string;
  handleDelegation: (request: VoiceRequest) => Promise<VoiceResult>;
  createSocket?: (url: string, options: WebSocket.ClientOptions) => LiveSocket;
}

const COLLECTION_IDLE_MS = 800;
const COLLECTION_MAX_MS = 2_000;
const ATTACH_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504]);

interface PendingCollection {
  delegationId: string;
  offsetMs: number;
  idleTimer: ReturnType<typeof setTimeout>;
  maxTimer: ReturnType<typeof setTimeout>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function connectLiveSession({
  sessionId,
  apiKey,
  handleDelegation,
  createSocket = (url, options) => new WebSocket(url, options),
}: LiveClientOptions) {
  const controller = new AbortController();

  let socket: LiveSocket | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let resolveClosed: () => void;
  let rejectClosed: (error: Error) => void;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });

  let queue = Promise.resolve();
  const transcript = createTranscriptBuffer();
  let pendingCollection: PendingCollection | undefined;

  function discardCollection() {
    if (!pendingCollection) return;
    clearTimeout(pendingCollection.idleTimer);
    clearTimeout(pendingCollection.maxTimer);
    pendingCollection = undefined;
  }

  function finishCollection(reason: "user_gap" | "max_wait" | "next_delegation") {
    const current = pendingCollection;
    if (!current) return;
    discardCollection();
    if (controller.signal.aborted) return;

    // Reserve new fragments before queuing; each request gets a separate batch.
    const message = transcript.takeSnapshot(current.offsetMs);
    console.log("[collection] frozen", current.delegationId, reason);
    queue = queue
      .then(() => respond(current.delegationId, message))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          console.error("Delegation failed:", error);
        }
      });
  }

  function extendCollection() {
    const current = pendingCollection;
    if (!current) return;
    clearTimeout(current.idleTimer);
    current.idleTimer = setTimeout(
      () => finishCollection("user_gap"),
      COLLECTION_IDLE_MS,
    );
  }

  function startCollection(delegationId: string, offsetMs: number) {
    if (controller.signal.aborted) return;
    finishCollection("next_delegation");
    pendingCollection = {
      delegationId,
      offsetMs,
      idleTimer: setTimeout(() => finishCollection("user_gap"), COLLECTION_IDLE_MS),
      maxTimer: setTimeout(() => finishCollection("max_wait"), COLLECTION_MAX_MS),
    };
    console.log("[collection] opened", delegationId);
  }

  controller.signal.addEventListener("abort", () => {
    discardCollection();
    clearTimeout(retryTimer);
  }, { once: true });

  function close() {
    controller.abort();
    socket?.close();
    resolveClosed();
  }

  function fail(error: Error) {
    controller.abort();
    rejectClosed(error);
    socket?.close();
  }

  function attach() {
    if (controller.signal.aborted) return;
    attempts++;
    let next: LiveSocket;
    try {
      next = createSocket(
        `wss://api.openai.com/v1/live/sessions/${encodeURIComponent(sessionId)}/attach`,
        { headers: { Authorization: `Bearer ${apiKey}` }, handshakeTimeout: 10_000 },
      );
    } catch {
      fail(new Error("Could not start the GPT-Live connection. Check the Live session ID and network configuration."));
      return;
    }
    socket = next;
    let retired = false;
    let opened = next.readyState === WebSocket.OPEN;

    next.once("unexpected-response", (_request, response) => {
      if (retired || controller.signal.aborted) return;
      const status = response.statusCode ?? 0;
      let delay = ATTACH_RETRY_DELAYS_MS[attempts - 1];
      const retryAfter = response.headers["retry-after"];
      if (delay !== undefined && typeof retryAfter === "string") {
        const requestedDelay = /^\d+$/.test(retryAfter)
          ? Number(retryAfter) * 1_000
          : Date.parse(retryAfter) - Date.now();
        if (Number.isFinite(requestedDelay)) delay = Math.max(delay, requestedDelay);
      }
      // A failed handshake owns no conversation. Retire it before its error/close events.
      retired = true;
      next.close();
      response.destroy();
      socket = undefined;

      if (!opened && RETRYABLE_HTTP_STATUSES.has(status) && delay !== undefined && delay <= 30_000) {
        console.warn(`GPT-Live attachment returned HTTP ${status}. Retrying in ${delay / 1_000}s (attempt ${attempts + 1}/4).`);
        retryTimer = setTimeout(attach, delay);
        return;
      }
      const hint = status === 401 || status === 403
        ? "Check OPENAI_API_KEY and that it belongs to the same project as the Live session."
        : "Keep the Orb call open and verify its Live session ID. If the call ended, start a new call and use its new ID. If the service remains unavailable, try again later.";
      fail(new Error(`GPT-Live attachment failed (HTTP ${status}) after ${attempts} attempt(s). ${hint}`));
    });

    next.on("error", (error) => {
      if (!retired && !controller.signal.aborted) fail(error);
    });
    next.once("close", () => {
      if (retired || controller.signal.aborted) return;
      if (!opened) {
        fail(new Error("GPT-Live closed before the backend attached. Keep the Orb call open and use its current Live session ID."));
        return;
      }
      close();
    });
    next.once("open", () => {
      if (retired || controller.signal.aborted) return;
      opened = true;
      console.log("Voice backend attached. You can request the test now.");
    });
    next.on("message", (data) => {
      if (!retired && opened) receive(data);
    });
  }

  async function respond(delegationId: string, message: string) {
    if (controller.signal.aborted) return;
    console.log("Delegation received:", delegationId);

    const result = await handleDelegation({
      delegationId,
      message,
      signal: controller.signal,
    });

    if (
      controller.signal.aborted ||
      socket?.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    socket.send(
      JSON.stringify({
        type: "session.commentary.append",
        event_id: randomUUID(),
        delegation_id: result.delegationId,
        content: result.text,
      }),
      (error) => {
        if (error) {
          console.error("Could not send the backend result:", error.message);
          return;
        }

        console.log("Backend result sent:", result.text);
      },
    );
  }

  function receive(data: WebSocket.RawData) {
    if (controller.signal.aborted) return;
    let event: unknown;

    try {
      event = JSON.parse(data.toString());
    } catch {
      console.error("Received an invalid JSON event.");
      return;
    }

    if (!isRecord(event)) return;

    const speaker =
      event.type === "session.input_transcript.delta"
        ? "user"
        : event.type === "session.output_transcript.delta"
          ? "assistant"
          : undefined;
    if (speaker) {
      const { delta, start_ms, end_ms } = event;
      if (
        typeof delta !== "string" ||
        typeof start_ms !== "number" ||
        typeof end_ms !== "number" ||
        !Number.isFinite(start_ms) ||
        !Number.isFinite(end_ms) ||
        start_ms < 0 ||
        end_ms < start_ms
      ) {
        console.warn("Ignoring an invalid transcript fragment.");
        return;
      }

      transcript.append({
        speaker,
        text: delta,
        startMs: start_ms,
        endMs: end_ms,
      });
      console.log(
        `[transcript:${speaker}] ${start_ms}-${end_ms} ms`,
        JSON.stringify(delta),
      );
      // Only user fragments extend the window; Ava can speak while it is open.
      if (speaker === "user") extendCollection();
      return;
    }

    if (event.type === "error") {
      console.error(
        "GPT-Live error:",
        isRecord(event.error) ? event.error.message : undefined,
      );
      return;
    }

    if (event.type === "session.closed") {
      close();
      return;
    }

    if (event.type === "session.commentary.appended") {
      console.log("Backend result acknowledged by GPT-Live.");
      return;
    }

    if (
      event.type !== "session.delegation.created" ||
      !isRecord(event.delegation) ||
      event.delegation.target !== "client" ||
      typeof event.delegation.id !== "string"
    ) {
      return;
    }

    if (
      typeof event.offset_ms !== "number" ||
      !Number.isFinite(event.offset_ms) ||
      event.offset_ms < 0
    ) {
      console.warn("Ignoring a delegation without a valid timestamp.");
      return;
    }

    startCollection(event.delegation.id, event.offset_ms);
  }

  attach();
  return { close, closed };
}
