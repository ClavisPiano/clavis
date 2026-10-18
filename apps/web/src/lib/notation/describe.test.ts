import { describe, expect, it } from "vitest";
import {
  FIXTURE_BASS_F3_G_MAJOR,
  FIXTURE_D_MINOR_RAISED_7TH,
  FIXTURE_GRAND_STAFF,
  FIXTURE_INTERVAL_C3_G3,
  FIXTURE_PERCUSSION_RHYTHM,
  SCORE_FIXTURES,
  type ScoreSpec,
} from "@clavis/core";
import { describeScore } from "./describe";

describe("describeScore without pitches (reading items)", () => {
  it("says the clef, key, meter and counts, never a pitch", () => {
    const text = describeScore(FIXTURE_BASS_F3_G_MAJOR, { pitches: false });
    expect(text).toBe("Bass clef, G major, no time signature, 1 bar. 1 note.");
  });

  it("never names a pitch for any fixture", () => {
    for (const score of Object.values(SCORE_FIXTURES)) {
      const text = describeScore(score, { pitches: false });
      expect(text).not.toMatch(/\b[A-G]( sharp| flat| double)* [0-9]\b/);
    }
  });

  it("describes a grand staff and a rhythm line", () => {
    expect(describeScore(FIXTURE_GRAND_STAFF, { pitches: false })).toMatch(
      /^Treble clef and Bass clef, /,
    );
    expect(describeScore(FIXTURE_PERCUSSION_RHYTHM, { pitches: false })).toMatch(/^Rhythm line, /);
  });
});

describe("describeScore with pitches (examples and previews)", () => {
  it("lists the note with its octave and length", () => {
    const text = describeScore(FIXTURE_BASS_F3_G_MAJOR, { pitches: true });
    expect(text).toContain("Bar 1: F");
    expect(text).toMatch(/3, whole\./);
  });

  it("names accidentals", () => {
    const text = describeScore(FIXTURE_D_MINOR_RAISED_7TH, { pitches: true });
    expect(text).toMatch(/C sharp 4|C sharp 3/);
  });

  it("lists both notes of an interval in order", () => {
    const text = describeScore(FIXTURE_INTERVAL_C3_G3, { pitches: true });
    expect(text.indexOf("C 3")).toBeGreaterThan(-1);
    expect(text.indexOf("G 3")).toBeGreaterThan(text.indexOf("C 3"));
  });

  it("labels the hands of a grand staff", () => {
    const text = describeScore(FIXTURE_GRAND_STAFF, { pitches: true });
    expect(text).toContain("Right hand. Bar 1:");
    expect(text).toContain("Left hand. Bar 1:");
  });

  it("does not call two treble staves right and left hand", () => {
    const treble = FIXTURE_GRAND_STAFF.staves[0];
    if (!treble) throw new Error("fixture has no staves");
    const score: ScoreSpec = { ...FIXTURE_GRAND_STAFF, staves: [treble, treble] };
    const text = describeScore(score, { pitches: true });
    expect(text).toContain("Staff 1. Bar 1:");
    expect(text).toContain("Staff 2. Bar 1:");
    expect(text).not.toMatch(/hand/i);
  });

  it("handles rests, dots, ties, chords and empty bars", () => {
    const score: ScoreSpec = {
      key: null,
      meter: null,
      staves: [
        {
          clef: "treble",
          lines: 5,
          measures: [
            [
              { kind: "rest", duration: { value: 4, dots: 1 } },
              {
                kind: "note",
                id: "n1",
                pitches: [
                  { step: "C", alter: 0, octave: 4 },
                  { step: "E", alter: -1, octave: 4 },
                ],
                duration: { value: 8, dots: 0, tie: "start" },
              },
            ],
            [],
          ],
        },
      ],
    };
    const text = describeScore(score, { pitches: true });
    expect(text).toContain("no key, no time signature, 2 bars.");
    expect(text).toContain("dotted quarter rest");
    expect(text).toContain("chord of C 4, E flat 4, eighth, tied to the next");
    expect(text).toContain("Bar 2: empty.");
  });
});
