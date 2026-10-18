import { describe, expect, it } from "vitest";
import { groupChords, noteName } from "./review";

const note = (pitch: number, onsetMs: number) => ({
  pitch,
  onsetMs,
  confidence: 0.9,
  source: "mic" as const,
});

describe("review helpers", () => {
  it("names notes in scientific pitch", () => {
    expect([60, 61, 21, 108].map(noteName)).toEqual(["C4", "C#4", "A0", "C8"]);
  });

  it("groups simultaneous notes into chords by onset and sorts them by pitch", () => {
    const chords = groupChords(
      [note(55, 10_500), note(48, 10_510), note(52, 10_560), note(53, 12_000), note(60, 12_030)],
      10_000,
    );
    expect(chords).toEqual([
      { atSec: 0.5, names: ["C3", "E3", "G3"] },
      { atSec: 2, names: ["F3", "C4"] },
    ]);
  });

  it("returns nothing for no notes", () => {
    expect(groupChords([], 0)).toEqual([]);
  });
});
