import {
    createAgentSession,
    ModelRuntime,
    DefaultResourceLoader,
    getAgentDir,
} from "@earendil-works/pi-coding-agent";

import type {
    AgentSession,
    CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";

export interface ModelConfig {
    provider: string;
    modelId: string;
    thinkingLevel: NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;
}

export async function createSession(
    modelConfig: ModelConfig,
    options: Pick<CreateAgentSessionOptions, "cwd" | "resourceLoader"> = {},
): Promise<AgentSession> {
    const modelRuntime = await ModelRuntime.create();

    const model = modelRuntime.getModel(
        modelConfig.provider,
        modelConfig.modelId
    );

    if (!model) {
        throw new Error(
            `Model not found: ${modelConfig.provider}/${modelConfig.modelId}`
        );
    }

    const { session } = await createAgentSession({
        ...options,
        modelRuntime,
        model,
        thinkingLevel: modelConfig.thinkingLevel,
        noTools: "all",
    });

    return session;
}