import { describe, expect, it } from "vitest";
import {
  guideMarks,
  homeChordSpec,
  homeNotes,
  homeNoteSpec,
  keyLabel,
  keySpec,
} from "./keyboard-practice";

const g = { tonic: "G", mode: "major" } as const;

describe("keyboard practice", () => {
  it("names the home note and chord from middle C upwards", () => {
    expect(homeNotes(g)).toEqual({ tonic: 67, chord: [67, 71, 74] });
    expect(homeNotes({ tonic: "C", mode: "major" })).toEqual({ tonic: 60, chord: [60, 64, 67] });
    expect(homeNotes({ tonic: "A", mode: "minor" }).chord).toEqual([69, 72, 76]);
  });

  it("plays the note, the chord together, and the key", () => {
    expect(homeNoteSpec(g).events).toMatchObject([{ midi: [67] }]);
    expect(homeChordSpec(g).events).toMatchObject([{ midi: [67, 71, 74] }]);
    const key = keySpec(g).events;
    expect(key.length).toBeGreaterThan(8);
    // The scale starts on the tonic and the cadence ends on the tonic chord.
    expect(key[0]?.midi[0]).toBe(67);
  });

  it("marks the tonic strongly and the rest of the chord lightly, in every octave", () => {
    const marks = guideMarks(g, 48, 84);
    expect(marks[55]).toBe("tonic");
    expect(marks[67]).toBe("tonic");
    expect(marks[79]).toBe("tonic");
    expect(marks[59]).toBe("chord");
    expect(marks[62]).toBe("chord");
    expect(marks[60]).toBeUndefined();
  });

  it("labels keys", () => {
    expect(keyLabel(g)).toBe("G major");
  });
});
