const provider = process.env.AVA_MODEL_PROVIDER;
const modelId = process.env.AVA_MODEL_ID;
const thinkingLevel = process.env.AVA_MODEL_THINKING_LEVEL

if (!provider || !modelId || !thinkingLevel) {
  throw new Error("AVA_MODEL_PROVIDER and AVA_MODEL_ID and AVA_MODEL_THINKING LEVEL are required.");
}

if (
  thinkingLevel !== "off" &&
  thinkingLevel !== "minimal" &&
  thinkingLevel !== "low" &&
  thinkingLevel !== "medium" &&
  thinkingLevel !== "high" &&
  thinkingLevel !== "xhigh" &&
  thinkingLevel !== "max"
) {
  throw new Error(
    `Invalid AVA_MODEL_THINKING_LEVEL: ${thinkingLevel}`,
  );
}

export const modelConfig = { provider, modelId, thinkingLevel } as const;