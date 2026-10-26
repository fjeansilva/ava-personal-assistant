import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

export function createGetLocalTimeTool(now: () => Date = () => new Date()) {
  const timeZone = "America/Sao_Paulo";
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23", weekday: "long", timeZoneName: "longOffset",
  });

  return defineTool({
    name: "get_local_time",
    label: "Get local time",
    description: "Get the current date, time and weekday in Jean's time zone (America/Sao_Paulo). Call again for a fresh reading; do not treat an earlier tool result as the current time.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_id, _params, signal) {
      signal?.throwIfAborted();
      const instant = now();
      const parts = Object.fromEntries(formatter.formatToParts(instant).map(({ type, value }) => [type, value]));
      const details = {
        timeZone,
        date: `${parts.year}-${parts.month}-${parts.day}`,
        time: `${parts.hour}:${parts.minute}:${parts.second}`,
        weekday: parts.weekday,
        utcOffset: parts.timeZoneName?.replace("GMT", "") || "+00:00",
        utc: instant.toISOString(),
      };
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  });
}
