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

  const socket = createSocket(
    `wss://api.openai.com/v1/live/sessions/${encodeURIComponent(sessionId)}/attach`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      handshakeTimeout: 10_000,
    },
  );

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

  controller.signal.addEventListener("abort", discardCollection, { once: true });

  function close() {
    controller.abort();
    socket.close();
  }

  const closed = new Promise<void>((resolve, reject) => {
    socket.once("error", (error) => {
      controller.abort();
      reject(error);
    });

    socket.once("close", () => {
      controller.abort();
      resolve();
    });
  });

  socket.on("open", () => {
    console.log("Voice backend attached. You can request the test now.");
  });

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
      socket.readyState !== WebSocket.OPEN
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

  socket.on("message", (data) => {
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
  });

  return { close, closed };
}
