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

    snapshot(offsetMs: number): string {
      // The offset identifies the delegation, not the end of its spoken request.
      // Include everything received before the collection window closes.
      const selected = [...fragments].sort(
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
