import { describe, expect, it } from "vitest";
import { ScoreSpecSchema, scoreNoteIds, spelledToMidi } from "../score/schema.js";
import { line } from "./line.js";

const base = {
  clef: "treble",
  key: { tonic: "C", mode: "major" },
  meter: { beats: 4, beatValue: 4 },
} as const;

describe("line", () => {
  it("builds a valid score with stable sequential ids across bars", () => {
    const score = line({ ...base, bars: ["E4q D4q C4h", "rw"] });
    expect(ScoreSpecSchema.safeParse(score).success).toBe(true);
    expect(scoreNoteIds(score)).toEqual(["n1", "n2", "n3"]);
    expect(score.staves[0]?.measures).toHaveLength(2);
    expect(score.staves[0]?.measures[1]).toEqual([
      { kind: "rest", duration: { value: 1, dots: 0 } },
    ]);
  });

  it.each([
    ["C4w", 60, { value: 1, dots: 0 }],
    ["D4h", 62, { value: 2, dots: 0 }],
    ["E4q.", 64, { value: 4, dots: 1 }],
    ["G3e", 55, { value: 8, dots: 0 }],
    ["B5s", 83, { value: 16, dots: 0 }],
  ])("reads %s as MIDI %i", (token, midi, duration) => {
    const el = line({ ...base, bars: [token] }).staves[0]?.measures[0]?.[0];
    expect(el?.kind).toBe("note");
    if (el?.kind !== "note") return;
    const pitch = el.pitches[0];
    if (pitch === undefined) throw new Error("no pitch");
    expect(spelledToMidi(pitch)).toBe(midi);
    expect(el.duration).toEqual(duration);
  });

  it.each(["C#4q", "H4q", "C4x", "C4", "4q"])("rejects the token %s", (token) => {
    expect(() => line({ ...base, bars: [token] })).toThrow();
  });
});
