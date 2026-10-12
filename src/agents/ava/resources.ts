import {
    DefaultResourceLoader,
    getAgentDir,
} from "@earendil-works/pi-coding-agent";

export async function createAvaResourceLoader(cwd: string) {
    const loader = new DefaultResourceLoader({
        cwd,
        agentDir: getAgentDir(),
        noContextFiles: true,
        appendSystemPromptOverride: () => [],
    });

    await loader.reload();

    return loader;
}