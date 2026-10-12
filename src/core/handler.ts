import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Conversation } from "../channels/contracts.js";

export function createMessageHandler(
    session: AgentSession,
): Conversation["handleMessage"] {
    return async ({ message, write, signal }) => {
        if (signal.aborted) return;

        const unsubscribe = session.subscribe((event) => {
            if (
                !signal.aborted &&
                event.type === "message_update" &&
                event.assistantMessageEvent.type === "text_delta"
            ) {
                write(event.assistantMessageEvent.delta);
            }
        });

        const onAbort = () => {
            void session.abort().catch((error) => {
                console.error("Cancellation failed:", error);
            });
        }

        signal.addEventListener("abort", onAbort, { once: true});

        try {
            await session.prompt(message);
        } finally {
            signal.removeEventListener("abort", onAbort);
            unsubscribe();
        }
    }
}