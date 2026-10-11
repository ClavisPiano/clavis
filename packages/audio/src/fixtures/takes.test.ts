import { describe, expect, it } from "vitest";
import { parseManifest } from "./manifest";
import { TAKES, noteName, takeToEntry, takeTruth, takesFor } from "./takes";

describe("recording takes", () => {
  const entries = (["voice", "acoustic-piano", "digital-piano"] as const).flatMap((instrument) =>
    takesFor(instrument).map((t) => takeToEntry(t, { instrument, device: "test device" })),
  );

  it("produce a valid manifest with unique ids", () => {
    expect(entries).toHaveLength(4 + 2 * 7);
    expect(() => parseManifest(entries)).not.toThrow();
  });

  it("derive onsets from tempo and the count-in", () => {
    const sung = TAKES.find((t) => t.slug === "sung-c-low");
    expect(sung).toBeDefined();
    if (sung === undefined) return;
    const truth = takeTruth(sung);
    // 60 bpm: 4 count-in beats = 4000 ms, then one note every 4 beats.
    expect(truth.slice(0, 2).map((n) => n.onsetMs)).toEqual([4000, 8000]);
    expect(truth.map((n) => n.midi)).toEqual([48, 55, 52, 59, 50, 57, 53]);
  });

  it("covers A0 to C8 in minor thirds and has simultaneous notes in two-hand takes", () => {
    const singles = TAKES.find((t) => t.slug === "singles-soft");
    expect(singles?.notes.map((n) => n.midi)).toEqual(
      Array.from({ length: 30 }, (_, i) => 21 + 3 * i),
    );
    expect(noteName(21)).toBe("A0");
    expect(noteName(108)).toBe("C8");
    const two = TAKES.find((t) => t.slug === "two-hand-c");
    expect(two?.notes.filter((n) => n.beat === 0).length).toBe(4);
  });
});
