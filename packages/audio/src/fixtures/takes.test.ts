import { describe, expect, it } from "vitest";
import { parseManifest } from "./manifest";
import {
  SELF_PACED_NOTE_MS,
  TAKES,
  noteName,
  selfPacedTruth,
  takeToEntry,
  takeTruth,
  takesFor,
} from "./takes";

describe("recording takes", () => {
  const entries = (["voice", "acoustic-piano", "digital-piano"] as const).flatMap((instrument) =>
    takesFor(instrument).map((t) => takeToEntry(t, { instrument, device: "test device" })),
  );

  it("produce a valid manifest with unique ids", () => {
    expect(entries).toHaveLength(4 + 2 * 8);
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

  it("covers the bass reading range C2 to E4 by semitone, with the reading input range", () => {
    const bass = TAKES.find((t) => t.slug === "singles-bass");
    expect(bass?.notes.map((n) => n.midi)).toEqual(Array.from({ length: 29 }, (_, i) => 36 + i));
    expect(bass?.expectedRange).toEqual({ low: 36, high: 64 });
  });

  it("takes self-paced truth from heard onsets and leaves skipped notes out", () => {
    const bass = TAKES.find((t) => t.slug === "singles-bass");
    if (!bass) throw new Error("no bass take");
    expect(bass.selfPaced).toBe(true);
    const onsets = bass.notes.map((_, i) => (i === 1 ? undefined : 1000 + i * 3000.4));
    const truth = selfPacedTruth(bass, onsets);
    expect(truth).toHaveLength(28);
    expect(truth[0]).toEqual({ midi: 36, onsetMs: 1000, offsetMs: 1000 + SELF_PACED_NOTE_MS });
    expect(truth[1]?.midi).toBe(38);
    const entry = takeToEntry(bass, { instrument: "acoustic-piano", device: "x" }, truth);
    expect(entry.notes).toBe(truth);
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
