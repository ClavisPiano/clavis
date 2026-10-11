import {
  FIXTURE_BASS_F3_G_MAJOR,
  FIXTURE_D_MINOR_RAISED_7TH,
  FIXTURE_INTERVAL_C3_G3,
} from "@clavis/core";
import { describe, expect, it } from "vitest";
import { midiName, noteNamer } from "./spelling";

describe("midiName", () => {
  it.each([
    [60, false, "C4"],
    [38, false, "D2"],
    [40, false, "E2"],
    [70, false, "A#4"],
    [70, true, "Bb4"],
    [21, false, "A0"],
    [127, false, "G9"],
  ])("%i (flats %s) is %s", (midi, flats, name) => {
    expect(midiName(midi, flats)).toBe(name);
  });
});

describe("noteNamer", () => {
  it("falls back to sharps without a score", () => {
    expect(noteNamer(undefined)(61)).toBe("C#4");
  });

  it("uses the written spelling of notes in the score", () => {
    expect(noteNamer(FIXTURE_BASS_F3_G_MAJOR)(54)).toBe("F#3");
    expect(noteNamer(FIXTURE_D_MINOR_RAISED_7TH)(49)).toBe("C#3");
    expect(noteNamer(FIXTURE_INTERVAL_C3_G3)(55)).toBe("G3");
  });

  it("spells unwritten notes with flats in a flat key and sharps otherwise", () => {
    // D minor has one flat in its signature; G major has a sharp.
    expect(noteNamer(FIXTURE_D_MINOR_RAISED_7TH)(70)).toBe("Bb4");
    expect(noteNamer(FIXTURE_BASS_F3_G_MAJOR)(70)).toBe("A#4");
  });
});
