import { majorKey, minorKey } from "@tonaljs/key";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { spelledToMidi, type SpelledPitch, type WrittenAccidental } from "../score/schema.js";
import {
  ALL_KEYS,
  formatStaffPosition,
  makeKey,
  parseStaffPosition,
  positionFromIndex,
  positionInKey,
  positionsInMidiRange,
  positionsInRange,
  staffPosition,
  stepOffset,
  writtenAccidental,
  type Key,
  type Mode,
  type StaffPosition,
} from "./index.js";

const pos = (s: string): StaffPosition => parseStaffPosition(s);
const pitchName = (p: SpelledPitch): string =>
  p.step + (p.alter > 0 ? "#".repeat(p.alter) : "b".repeat(-p.alter)) + String(p.octave);
const sp = (step: SpelledPitch["step"], alter: number, octave: number): SpelledPitch => ({
  step,
  alter,
  octave,
});

describe("staff positions", () => {
  it.each([
    ["C0", 0],
    ["D0", 1],
    ["B0", 6],
    ["C1", 7],
    ["F3", 24],
    ["C4", 28],
  ])("staffPosition(%s) = %i", (s, idx) => {
    expect(staffPosition(pos(s))).toBe(idx);
    expect(formatStaffPosition(positionFromIndex(idx))).toBe(s);
  });

  it("rejects malformed position text", () => {
    for (const bad of ["", "H3", "F", "f3", "F#3", "3F"]) {
      expect(() => parseStaffPosition(bad)).toThrow(RangeError);
    }
  });

  it("stepOffset crosses octave boundaries", () => {
    expect(formatStaffPosition(stepOffset(pos("B2"), 1))).toBe("C3");
    expect(formatStaffPosition(stepOffset(pos("C3"), -1))).toBe("B2");
    expect(formatStaffPosition(stepOffset(pos("C2"), 14))).toBe("C4");
  });

  it("positionsInRange is inclusive and ascending", () => {
    expect(positionsInRange(pos("A2"), pos("D3")).map(formatStaffPosition)).toEqual([
      "A2",
      "B2",
      "C3",
      "D3",
    ]);
    expect(positionsInRange(pos("D3"), pos("D3"))).toHaveLength(1);
    expect(positionsInRange(pos("E3"), pos("D3"))).toEqual([]);
  });

  it("positionsInMidiRange filters by sounding pitch in the key", () => {
    const names = (low: number, high: number, key: Key): string[] =>
      positionsInMidiRange({ low, high }, key).map(formatStaffPosition);
    // C major: C2 (36) up to G2 (43).
    expect(names(36, 43, makeKey("C", "major"))).toEqual(["C2", "D2", "E2", "F2", "G2"]);
    // G major: F2 sounds F#2 (42), so a range ending at F2 natural (41) drops it.
    expect(names(40, 41, makeKey("G", "major"))).toEqual(["E2"]);
    // Bb major: B2 sounds Bb2 (46) and now fits under 46.
    expect(names(44, 46, makeKey("Bb", "major"))).toEqual(["A2", "B2"]);
  });
});

describe("positionInKey", () => {
  // [position, tonic, mode, midi, spelled pitch, raise]
  const cases: [string, string, Mode, number, string, 6 | 7 | undefined][] = [
    ["F3", "G", "major", 54, "F#3", undefined],
    ["B2", "F", "major", 46, "Bb2", undefined],
    ["C4", "D", "major", 61, "C#4", undefined],
    ["F3", "D", "major", 54, "F#3", undefined],
    ["C3", "D", "major", 49, "C#3", undefined],
    ["B2", "Bb", "major", 46, "Bb2", undefined],
    ["E2", "Eb", "major", 39, "Eb2", undefined],
    ["B2", "Eb", "major", 46, "Bb2", undefined],
    ["A2", "Eb", "major", 44, "Ab2", undefined],
    ["C3", "Eb", "major", 48, "C3", undefined],
    ["C3", "D", "minor", 48, "C3", undefined],
    ["C3", "D", "minor", 49, "C#3", 7],
    ["B2", "D", "minor", 46, "Bb2", undefined],
    ["E3", "G", "minor", 51, "Eb3", undefined],
    ["E3", "G", "minor", 52, "E3", 6],
    ["F3", "G", "minor", 53, "F3", undefined],
    ["F3", "G", "minor", 54, "F#3", 7],
    ["G2", "A", "minor", 43, "G2", undefined],
    ["G2", "A", "minor", 44, "G#2", 7],
    ["F2", "A", "minor", 41, "F2", undefined],
    ["F2", "A", "minor", 42, "F#2", 6],
    // A raise only touches its own letter.
    ["D3", "A", "minor", 50, "D3", 7],
    // A raise is ignored in major keys.
    ["F3", "C", "major", 53, "F3", 7],
    // Sharp minor keys spell the raised 7th with a double sharp.
    ["F3", "G#", "minor", 55, "F##3", 7],
  ];
  it.each(cases)("%s in %s %s = %i (%s), raise %s", (p, tonic, mode, midi, name, raise) => {
    const r = positionInKey(pos(p), makeKey(tonic, mode), raise === undefined ? {} : { raise });
    expect(r.midi).toBe(midi);
    expect(pitchName(r.pitch)).toBe(name);
  });

  it.each(["C2", "F2", "C3", "G3", "C4"])("landmark %s is unchanged in C major", (p) => {
    const r = positionInKey(pos(p), makeKey("C", "major"));
    expect(r.pitch.alter).toBe(0);
    expect(pitchName(r.pitch)).toBe(p);
  });

  it("matches tonal scale notes for every key in ALL_KEYS", () => {
    for (const key of ALL_KEYS) {
      const notes =
        key.mode === "major" ? majorKey(key.tonic).scale : minorKey(key.tonic).natural.scale;
      expect(notes).toHaveLength(7);
      const tonicStep = key.tonic.charAt(0);
      const start = pos(`${tonicStep}3`);
      notes.forEach((note, i) => {
        const got = positionInKey(stepOffset(start, i), key);
        // Ignore the octave: tonal's pitch class names carry none.
        expect(pitchName(got.pitch).replace(/[0-9]+$/, ""), `${key.tonic} ${key.mode}`).toBe(note);
      });
    }
  });
});

describe("writtenAccidental", () => {
  const cases: [string, SpelledPitch, Key, WrittenAccidental | undefined][] = [
    ["F#3 in G major", sp("F", 1, 3), makeKey("G", "major"), undefined],
    ["F3 in G major", sp("F", 0, 3), makeKey("G", "major"), "natural"],
    ["F3 in C major", sp("F", 0, 3), makeKey("C", "major"), undefined],
    ["F#3 in C major", sp("F", 1, 3), makeKey("C", "major"), "sharp"],
    ["Bb2 in C major", sp("B", -1, 2), makeKey("C", "major"), "flat"],
    ["C#3 in D minor (raised 7)", sp("C", 1, 3), makeKey("D", "minor"), "sharp"],
    ["Bb2 in D minor", sp("B", -1, 2), makeKey("D", "minor"), undefined],
    ["E3 in G minor (raised 6)", sp("E", 0, 3), makeKey("G", "minor"), "natural"],
    ["Eb3 in G minor", sp("E", -1, 3), makeKey("G", "minor"), undefined],
    ["F#3 in G minor (raised 7)", sp("F", 1, 3), makeKey("G", "minor"), "sharp"],
    ["F##3 in G# minor", sp("F", 2, 3), makeKey("G#", "minor"), "double-sharp"],
    ["Bbb2 in F major", sp("B", -2, 2), makeKey("F", "major"), "double-flat"],
    ["Bb2 in Eb major", sp("B", -1, 2), makeKey("Eb", "major"), undefined],
  ];
  it.each(cases)("%s", (_name, pitch, key, expected) => {
    expect(writtenAccidental(pitch, key)).toBe(expected);
  });

  it("is undefined for signature notes and defined for any raised degree that moves", () => {
    for (const key of ALL_KEYS) {
      for (let i = 0; i < 7; i++) {
        const p = stepOffset(pos("C3"), i);
        const plain = positionInKey(p, key);
        expect(writtenAccidental(plain.pitch, key)).toBeUndefined();
        for (const raise of [6, 7] as const) {
          const raised = positionInKey(p, key, { raise });
          if (raised.midi !== plain.midi) {
            expect(writtenAccidental(raised.pitch, key)).toBeDefined();
          }
        }
      }
    }
  });
});

describe("properties", () => {
  const posArb = fc
    .record({
      step: fc.constantFrom("C", "D", "E", "F", "G", "A", "B"),
      octave: fc.integer({ min: 1, max: 6 }),
    })
    .map((p): StaffPosition => p);
  const keyArb = fc.constantFrom(...ALL_KEYS);
  const raiseArb = fc.constantFrom(undefined, 6 as const, 7 as const);

  it("stepOffset then its inverse round-trips", () => {
    fc.assert(
      fc.property(posArb, fc.integer({ min: -20, max: 20 }), (p, n) => {
        expect(stepOffset(stepOffset(p, n), -n)).toEqual(p);
      }),
    );
  });

  it("format and parse round-trip", () => {
    fc.assert(
      fc.property(posArb, (p) => {
        expect(parseStaffPosition(formatStaffPosition(p))).toEqual(p);
      }),
    );
  });

  it("MIDI order follows staff order in any key", () => {
    fc.assert(
      fc.property(posArb, keyArb, raiseArb, (p, k, raise) => {
        const opts = raise === undefined ? {} : { raise };
        const lo = positionInKey(p, k, opts).midi;
        const hi = positionInKey(stepOffset(p, 1), k, opts).midi;
        expect(hi).toBeGreaterThanOrEqual(lo);
      }),
    );
  });

  it("pitch and midi agree", () => {
    fc.assert(
      fc.property(posArb, keyArb, raiseArb, (p, k, raise) => {
        const r = positionInKey(p, k, raise === undefined ? {} : { raise });
        expect(spelledToMidi(r.pitch)).toBe(r.midi);
      }),
    );
  });
});
