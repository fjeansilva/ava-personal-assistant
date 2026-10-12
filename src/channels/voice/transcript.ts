interface TranscriptFragment {
  speaker: "user" | "assistant";
  text: string;
  startMs: number;
  endMs: number;
}

export function createTranscriptBuffer() {
  const fragments: TranscriptFragment[] = [];

  return {
    append(fragment: TranscriptFragment) {
      fragments.push({ ...fragment });
    },

    takeSnapshot(offsetMs: number): string {
      // The offset identifies the delegation, not the end of its spoken request.
      // Reserve all pending arrivals for this batch, including late fragments.
      // Queued requests must not take the same fragments again.
      const selected = fragments.splice(0).sort(
        (a, b) => a.startMs - b.startMs || a.endMs - b.endMs,
      );
      if (selected.length === 0) return "";

      return JSON.stringify(
        { delegationOffsetMs: offsetMs, fragments: selected },
        null,
        2,
      );
    },
  };
}
