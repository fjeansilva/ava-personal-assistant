import type {
    ChannelMessage,
    Conversation,
} from "../contracts.js";

export type VoiceRequest = Pick<
    ChannelMessage,
    "message" | "signal"
> & {
    delegationId: string;
};

export interface VoiceResult {
    delegationId: string;
    text: string;
}
export function createVoiceAdapter(conversation: Conversation) {
    let running = false;

    return async function handleDelegation(
        request: VoiceRequest,
    ): Promise<VoiceResult> {
        request.signal.throwIfAborted();

        if (running) {
            throw new Error("A voice request is already running.");
        }

        running = true;

        try {
            let text = "";

            await conversation.handleMessage({
                message: request.message,
                signal: request.signal,
                write(delta) {
                    if (!request.signal.aborted) {
                        text += delta;
                    }
                },
            });

            request.signal.throwIfAborted();

            return {
                delegationId: request.delegationId,
                text,
            };
        } finally {
            running = false;
        }
    };
}