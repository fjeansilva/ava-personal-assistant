import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

export const expressions = [
  "neutra", "atenta", "pensativa", "feliz", "surpresa",
  "sonolenta", "piscadinha", "triste", "desconfiada",
] as const;

type Expression = typeof expressions[number];
type ApplyExpression = (
  request: { expression: Expression; duration_ms: number },
  signal?: AbortSignal,
) => Promise<void>;

export function createSetExpressionTool(applyExpression: ApplyExpression) {
  return defineTool({
    name: "set_expression",
    label: "Set facial expression",
    description: "Change Ava's face in the connected Orb browser temporarily. Use feliz for good news or thanks, surpresa for surprises, pensativa while analyzing, triste for bad news or apologies, desconfiada for doubt, piscadinha for playful complicity, sonolenta for nighttime goodbyes, atenta for questions, and neutra to return to neutral. Success means the browser applied the expression; it does not mean speech was delivered.",
    parameters: Type.Object({
      expression: Type.Union(expressions.map((name) => Type.Literal(name))),
      duration_ms: Type.Optional(Type.Integer({ minimum: 800, maximum: 15_000, description: "Duration in milliseconds. Defaults to 3000." })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal) {
      signal?.throwIfAborted();
      const duration_ms = params.duration_ms ?? 3_000;
      // Also validate direct invocations outside Pi's normal schema validation.
      if (!expressions.includes(params.expression) || !Number.isInteger(duration_ms) || duration_ms < 800 || duration_ms > 15_000) {
        throw new Error("Invalid expression or duration (expected 800–15000 ms).");
      }
      await applyExpression({ expression: params.expression, duration_ms }, signal);
      signal?.throwIfAborted();
      const details = { applied: true, expression: params.expression, duration_ms };
      return {
        content: [{ type: "text", text: JSON.stringify(details) }],
        details,
      };
    },
  });
}
