export interface ExpressionRequest {
  expression: string;
  duration_ms: number;
}

interface OrbClientOptions {
  sessionId: string;
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

// This is the application's local UI connection, separate from GPT-Live.
export function createOrbClient({
  sessionId,
  token,
  baseUrl = "http://127.0.0.1:3000",
  fetchImpl = fetch,
}: OrbClientOptions) {
  if (!sessionId || !token.trim()) throw new Error("Orb session ID and bridge token are required.");
  const url = new URL(baseUrl);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username || url.password || url.search || url.hash || url.pathname !== "/"
  ) {
    throw new Error("AVA_ORB_BRIDGE_URL must be a local HTTP origin.");
  }
  const endpoint = new URL(`/api/orb/${encodeURIComponent(sessionId)}/expression`, url);

  return {
    async setExpression(request: ExpressionRequest, signal?: AbortSignal) {
      const signals = [AbortSignal.timeout(6_000)];
      if (signal) signals.push(signal);
      const response = await fetchImpl(endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
        signal: AbortSignal.any(signals),
      });
      if (!response.ok) {
        throw new Error(`Orb could not confirm the expression (HTTP ${response.status}). Check the browser session and bridge configuration.`);
      }
      const result: unknown = await response.json();
      if (
        typeof result !== "object" || result === null ||
        !("applied" in result) || result.applied !== true ||
        !("expression" in result) || result.expression !== request.expression ||
        !("duration_ms" in result) || result.duration_ms !== request.duration_ms
      ) {
        throw new Error("Orb returned an invalid expression confirmation.");
      }
    },
  };
}
