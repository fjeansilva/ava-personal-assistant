import {
    createAgentSession,
    ModelRuntime,
    DefaultResourceLoader,
    getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { modelConfig } from "./settings.js";

export async function createAvaSession() {
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

    const cwd = process.cwd();
    const agentDir = getAgentDir();

    const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        appendSystemPromptOverride: () => [],
    });

    await loader.reload();

    const { session } = await createAgentSession({
        modelRuntime,
        model,
        thinkingLevel: modelConfig.thinkingLevel,
        noTools: "all",
        resourceLoader: loader,
    });

    return session;
}