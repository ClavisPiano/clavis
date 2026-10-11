import { describe, expect, it } from "vitest";
import type { AttemptError } from "@clavis/core";
import { conceptTip } from "./index";

const e = (code: string, detail?: AttemptError["detail"]): AttemptError =>
  detail === undefined ? { code } : { code, detail };

describe("conceptTip", () => {
  it.each([
    [
      "major 3 heard as 5",
      [e("degree.confusion.3-5")],
      "major",
      "3 is the bright middle of the home chord, while 5 is the strong, open top of the home chord.",
    ],
    [
      "major 7 heard as 1",
      [e("degree.confusion.7-1")],
      "major",
      "7 is a half step below home and pulls up to 1, while 1 is home, settled and finished.",
    ],
    [
      "minor 3 heard as 5",
      [e("degree.confusion.3-5")],
      "minor",
      "3 is the dark middle of the minor home chord, while 5 is the strong, open top of the home chord.",
    ],
    [
      "raised 7 in minor",
      [e("degree.confusion.#7-1")],
      "minor",
      "The raised 7 of harmonic minor is a half step below home and pulls up to 1, while 1 is home, settled and finished.",
    ],
    [
      "a wrong note in a cell",
      [e("sequence.wrong-note", { index: 1, expectedDegree: "2", playedDegree: "3" })],
      "major",
      "2 is one step above home and wants to fall back to 1, while 3 is the bright middle of the home chord.",
    ],
    [
      "a late rhythm note",
      [e("rhythm.late", { index: 2 })],
      "major",
      "Count the beat under the rhythm: a note between two beats lands exactly halfway.",
    ],
    [
      "tempo drift",
      [e("rhythm.tempo-drift", { ratio: 1.2 })],
      "major",
      "Feel the beat under the rhythm and keep it steady. The gaps are measured against your own tempo.",
    ],
    [
      "no sung note",
      [e("sing.none")],
      "major",
      'Sing on an open vowel such as "ah", loud enough to be heard, and hold the note steady for about a second.',
    ],
    [
      "the first error with a tip wins",
      [e("response.timeout"), e("degree.confusion.1-5"), e("rhythm.extra")],
      "major",
      "1 is home, settled and finished, while 5 is the strong, open top of the home chord.",
    ],
  ] as const)("%s", (_name, errors, mode, text) => {
    expect(conceptTip(errors, mode)).toEqual({ text });
  });

  it.each([
    ["no errors", []],
    ["a chromatic degree", [e("degree.confusion.3-b3")]],
    ["flat singing (a practical issue, not a concept)", [e("sing.flat", { cents: -40 })]],
    ["a timeout", [e("response.timeout")]],
    ["a cell wrong note without degrees", [e("sequence.wrong-note", { index: 0 })]],
  ] as const)("gives nothing for %s", (_name, errors) => {
    expect(conceptTip(errors, "major")).toBeUndefined();
  });
});

describe("conceptTip for reading", () => {
  const octave =
    "Right letter, wrong octave. Count ledger lines from middle C, or up and down from the F line, and check which register your hand is in.";
  const wrong =
    "Find the nearest landmark (low C, the F line, middle C) and count lines and spaces from it. Check the key signature for sharps or flats.";

  it.each([
    ["octave, not reading", [e("pitch.octave", { expected: 41, played: 53 })], undefined, octave],
    ["octave, reading", [e("pitch.octave")], { reading: true }, octave],
    [
      "wrong pitch, reading",
      [e("pitch.wrong", { expected: "F", played: "G" })],
      { reading: true },
      wrong,
    ],
    [
      "octave beats a later wrong pitch",
      [e("pitch.octave"), e("pitch.wrong")],
      { reading: true },
      octave,
    ],
  ] as const)("%s", (_name, errors, opts, text) => {
    expect(conceptTip(errors, "major", opts)).toEqual({ text });
  });

  it.each([
    ["wrong pitch, no options", undefined],
    ["wrong pitch, reading false", { reading: false }],
  ] as const)("gives no pitch.wrong tip for %s", (_name, opts) => {
    expect(
      conceptTip([e("pitch.wrong", { expected: "F", played: "G" })], "major", opts),
    ).toBeUndefined();
  });
});
