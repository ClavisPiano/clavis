import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { at } from "./util.js";
import {
  ALL_KEYS,
  MAX_VOICE_LEAP,
  cadence,
  canonicalKey,
  circleOfFifthsNext,
  degreeToMidi,
  degreeToPitchClass,
  enharmonicKey,
  keyFamily,
  keySignatureAccidentals,
  keysInFamilies,
  makeKey,
  midiToDegree,
  relativeMajor,
  relativeMinor,
  scaleMidi,
  tonicMidiAt,
  tonicMidiForRange,
  type Key,
  type VoiceRange,
} from "./index.js";

const keyName = (k: Key): string => `${k.tonic} ${k.mode}`;
const keyArb = fc.constantFrom(...ALL_KEYS);

const MAJOR_TABLE: Record<string, { sig: number; family: string; degrees: string[] }> = {
  C: { sig: 0, family: "A", degrees: ["C", "D", "E", "F", "G", "A", "B"] },
  G: { sig: 1, family: "A", degrees: ["G", "A", "B", "C", "D", "E", "F#"] },
  D: { sig: 2, family: "B", degrees: ["D", "E", "F#", "G", "A", "B", "C#"] },
  A: { sig: 3, family: "B", degrees: ["A", "B", "C#", "D", "E", "F#", "G#"] },
  E: { sig: 4, family: "C", degrees: ["E", "F#", "G#", "A", "B", "C#", "D#"] },
  B: { sig: 5, family: "C", degrees: ["B", "C#", "D#", "E", "F#", "G#", "A#"] },
  "F#": { sig: 6, family: "C", degrees: ["F#", "G#", "A#", "B", "C#", "D#", "E#"] },
  Db: { sig: -5, family: "C", degrees: ["Db", "Eb", "F", "Gb", "Ab", "Bb", "C"] },
  Ab: { sig: -4, family: "C", degrees: ["Ab", "Bb", "C", "Db", "Eb", "F", "G"] },
  Eb: { sig: -3, family: "B", degrees: ["Eb", "F", "G", "Ab", "Bb", "C", "D"] },
  Bb: { sig: -2, family: "B", degrees: ["Bb", "C", "D", "Eb", "F", "G", "A"] },
  F: { sig: -1, family: "A", degrees: ["F", "G", "A", "Bb", "C", "D", "E"] },
};

// Natural minor degrees; harmonic 7th is listed separately.
const MINOR_TABLE: Record<
  string,
  { sig: number; family: string; degrees: string[]; leading: string }
> = {
  A: { sig: 0, family: "A", degrees: ["A", "B", "C", "D", "E", "F", "G"], leading: "G#" },
  E: { sig: 1, family: "A", degrees: ["E", "F#", "G", "A", "B", "C", "D"], leading: "D#" },
  D: { sig: -1, family: "A", degrees: ["D", "E", "F", "G", "A", "Bb", "C"], leading: "C#" },
  B: { sig: 2, family: "B", degrees: ["B", "C#", "D", "E", "F#", "G", "A"], leading: "A#" },
  G: { sig: -2, family: "B", degrees: ["G", "A", "Bb", "C", "D", "Eb", "F"], leading: "F#" },
  "F#": { sig: 3, family: "B", degrees: ["F#", "G#", "A", "B", "C#", "D", "E"], leading: "E#" },
  C: { sig: -3, family: "B", degrees: ["C", "D", "Eb", "F", "G", "Ab", "Bb"], leading: "B" },
  "C#": { sig: 4, family: "C", degrees: ["C#", "D#", "E", "F#", "G#", "A", "B"], leading: "B#" },
  F: { sig: -4, family: "C", degrees: ["F", "G", "Ab", "Bb", "C", "Db", "Eb"], leading: "E" },
  "G#": { sig: 5, family: "C", degrees: ["G#", "A#", "B", "C#", "D#", "E", "F#"], leading: "F##" },
  Bb: { sig: -5, family: "C", degrees: ["Bb", "C", "Db", "Eb", "F", "Gb", "Ab"], leading: "A" },
  "D#": { sig: 6, family: "C", degrees: ["D#", "E#", "F#", "G#", "A#", "B", "C#"], leading: "C##" },
};

describe("keys", () => {
  it("has 24 distinct keys", () => {
    expect(ALL_KEYS).toHaveLength(24);
    expect(new Set(ALL_KEYS.map(keyName)).size).toBe(24);
  });

  it.each(Object.entries(MAJOR_TABLE))("major %s: signature, family, degrees", (tonic, row) => {
    const key = makeKey(tonic, "major");
    expect(keySignatureAccidentals(key)).toBe(row.sig);
    expect(keyFamily(key)).toBe(row.family);
    expect([1, 2, 3, 4, 5, 6, 7].map((d) => degreeToPitchClass(key, d))).toEqual(row.degrees);
    expect(degreeToPitchClass(key, 8)).toBe(row.degrees[0]);
  });

  it.each(Object.entries(MINOR_TABLE))("minor %s: signature, family, degrees", (tonic, row) => {
    const key = makeKey(tonic, "minor");
    expect(keySignatureAccidentals(key)).toBe(row.sig);
    expect(keyFamily(key)).toBe(row.family);
    expect([1, 2, 3, 4, 5, 6, 7].map((d) => degreeToPitchClass(key, d))).toEqual(row.degrees);
    expect(degreeToPitchClass(key, 7, { minorVariant: "harmonic" })).toBe(row.leading);
  });

  it("minor shares the family and signature of its relative major", () => {
    for (const k of ALL_KEYS) {
      const rel = k.mode === "major" ? relativeMinor(k) : relativeMajor(k);
      expect(keyFamily(rel)).toBe(keyFamily(k));
      expect(keySignatureAccidentals(rel)).toBe(keySignatureAccidentals(k));
      const back = k.mode === "major" ? relativeMajor(rel) : relativeMinor(rel);
      expect(back).toEqual(k);
    }
    expect(relativeMinor(makeKey("C", "major"))).toEqual({ tonic: "A", mode: "minor" });
    expect(relativeMajor(makeKey("F#", "minor"))).toEqual({ tonic: "A", mode: "major" });
  });

  it("rejects unsupported tonics", () => {
    for (const t of ["E#", "B#", "Cb", "Fb", "C##", "Bbb", "H", "c", "", "C4"]) {
      expect(() => makeKey(t, "major")).toThrow(RangeError);
    }
    expect(() => makeKey("C#", "major")).toThrow(RangeError);
    expect(() => makeKey("Gb", "minor")).toThrow(RangeError);
    expect(() => keyFamily({ tonic: "E#", mode: "minor" })).toThrow(RangeError);
  });

  it("handles enharmonic pairs", () => {
    expect(enharmonicKey(makeKey("F#", "major"))).toEqual({ tonic: "Gb", mode: "major" });
    expect(enharmonicKey(makeKey("Gb", "major"))).toEqual({ tonic: "F#", mode: "major" });
    expect(enharmonicKey(makeKey("D#", "minor"))).toEqual({ tonic: "Eb", mode: "minor" });
    expect(enharmonicKey(makeKey("Eb", "major"))).toBeNull();
    expect(canonicalKey(makeKey("Gb", "major"))).toEqual({ tonic: "F#", mode: "major" });
    expect(canonicalKey(makeKey("Eb", "minor"))).toEqual({ tonic: "D#", mode: "minor" });
    const gb = makeKey("Gb", "major");
    expect(keySignatureAccidentals(gb)).toBe(-6);
    expect(keyFamily(gb)).toBe("C");
    expect(keySignatureAccidentals(makeKey("Eb", "minor"))).toBe(-6);
  });

  it("circles the fifths and visits every key of a mode", () => {
    expect(circleOfFifthsNext(makeKey("C", "major"))).toEqual({ tonic: "G", mode: "major" });
    expect(circleOfFifthsNext(makeKey("C", "major"), "flat")).toEqual({
      tonic: "F",
      mode: "major",
    });
    expect(circleOfFifthsNext(makeKey("F", "major"))).toEqual({ tonic: "C", mode: "major" });
    expect(circleOfFifthsNext(makeKey("Gb", "major"))).toEqual({ tonic: "Db", mode: "major" });
    fc.assert(
      fc.property(keyArb, (k) => {
        const seen = new Set<string>();
        let cur = k;
        for (let i = 0; i < 12; i++) {
          seen.add(keyName(cur));
          cur = circleOfFifthsNext(cur);
        }
        expect(seen.size).toBe(12);
        expect(keyName(cur)).toBe(keyName(k));
        expect(circleOfFifthsNext(circleOfFifthsNext(k), "flat")).toEqual(k);
      }),
    );
  });

  it("selects keys by family", () => {
    expect(keysInFamilies(["A"]).map(keyName)).toEqual([
      "C major",
      "G major",
      "F major",
      "A minor",
      "E minor",
      "D minor",
    ]);
    expect(keysInFamilies(["A", "B", "C"])).toHaveLength(24);
    expect(keysInFamilies([])).toEqual([]);
    expect(keysInFamilies(["C"])).toHaveLength(10);
  });
});

describe("degrees", () => {
  const c = makeKey("C", "major");
  const aMin = makeKey("A", "minor");

  it("maps degrees across octaves", () => {
    const t = tonicMidiAt(c, 4);
    expect(t).toBe(60);
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((d) => degreeToMidi(c, d, t))).toEqual([
      60, 62, 64, 65, 67, 69, 71, 72,
    ]);
    expect(degreeToMidi(c, 0, t)).toBe(59);
    expect(degreeToMidi(c, -6, t)).toBe(48);
    expect(degreeToMidi(c, 15, t)).toBe(84);
    expect(degreeToMidi(c, 3, t, { alteration: -1 })).toBe(63);
  });

  it("supports minor variants", () => {
    const t = tonicMidiAt(aMin, 4);
    expect(t).toBe(69);
    expect(scaleMidi(aMin, t)).toEqual([69, 71, 72, 74, 76, 77, 79, 81]);
    expect(scaleMidi(aMin, t, { minorVariant: "harmonic" })).toEqual([
      69, 71, 72, 74, 76, 77, 80, 81,
    ]);
    expect(scaleMidi(aMin, t, { minorVariant: "melodic" })).toEqual([
      69, 71, 72, 74, 76, 78, 80, 81,
    ]);
  });

  it("classifies chromatic notes", () => {
    expect(midiToDegree(c, 63, 60)).toEqual({ degree: 3, alteration: -1 });
    expect(midiToDegree(c, 66, 60)).toEqual({ degree: 4, alteration: 1 });
    expect(midiToDegree(c, 61, 60)).toEqual({ degree: 2, alteration: -1 });
    expect(midiToDegree(c, 62, 60)).toEqual({ degree: 2, alteration: 0 });
    expect(midiToDegree(aMin, 80, 69)).toEqual({ degree: 7, alteration: 1 });
  });

  it("rejects a tonicMidi with the wrong pitch class", () => {
    expect(() => degreeToMidi(c, 1, 61)).toThrow(RangeError);
    expect(() => degreeToMidi(c, 1.5, 60)).toThrow(RangeError);
  });

  it("round-trips degree -> midi -> degree", () => {
    fc.assert(
      fc.property(
        keyArb,
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: -20, max: 28 }),
        fc.constantFrom<-1 | 0 | 1>(-1, 0, 1),
        fc.constantFrom("natural", "harmonic", "melodic"),
        (key, octave, degree, alteration, minorVariant) => {
          const t = tonicMidiAt(key, octave);
          const midi = degreeToMidi(key, degree, t, { minorVariant, alteration });
          const info = midiToDegree(key, midi, t, { minorVariant });
          // The result may spell a chromatic note differently, but must describe the same pitch.
          expect(
            degreeToMidi(key, info.degree, t, { minorVariant, alteration: info.alteration }),
          ).toBe(midi);
          if (alteration === 0) expect(info).toEqual({ degree, alteration: 0 });
        },
      ),
    );
  });

  it("round-trips every in-scale degree exactly for every key", () => {
    for (const key of ALL_KEYS) {
      for (const octave of [2, 3, 4, 5]) {
        const t = tonicMidiAt(key, octave);
        for (let d = -6; d <= 15; d++) {
          expect(midiToDegree(key, degreeToMidi(key, d, t), t)).toEqual({
            degree: d,
            alteration: 0,
          });
        }
      }
    }
  });

  it("degree pitch class agrees with degree midi", () => {
    fc.assert(
      fc.property(keyArb, fc.integer({ min: -10, max: 20 }), (key, degree) => {
        const t = tonicMidiAt(key, 4);
        const pcMidi = degreeToMidi(key, degree, t) % 12;
        const name = degreeToPitchClass(key, degree);
        const expected = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[name[0] as "C"];
        const acc = name
          .slice(1)
          .split("")
          .reduce((s, ch) => s + (ch === "#" ? 1 : -1), 0);
        expect((((expected + acc) % 12) + 12) % 12).toBe(pcMidi);
      }),
    );
  });

  it("picks a tonic octave that fits the range", () => {
    const range: VoiceRange = { low: 55, high: 83 };
    for (const key of ALL_KEYS) {
      const r = tonicMidiForRange(key, range, { low: 1, high: 8 });
      expect(r.fits).toBe(true);
      expect(degreeToMidi(key, 1, r.tonicMidi)).toBeGreaterThanOrEqual(range.low);
      expect(degreeToMidi(key, 8, r.tonicMidi)).toBeLessThanOrEqual(range.high);
      const around = tonicMidiForRange(key, range, { low: -3, high: 5 });
      expect(around.fits).toBe(true);
      expect(degreeToMidi(key, -3, around.tonicMidi)).toBeGreaterThanOrEqual(range.low);
      expect(degreeToMidi(key, 5, around.tonicMidi)).toBeLessThanOrEqual(range.high);
    }
  });

  it("flags impossible fits and returns the best effort", () => {
    const r = tonicMidiForRange(c, { low: 60, high: 66 }, { low: 1, high: 8 });
    expect(r.fits).toBe(false);
    expect(r.tonicMidi % 12).toBe(0);
    const exact = tonicMidiForRange(c, { low: 60, high: 72 }, { low: 1, high: 8 });
    expect(exact).toEqual({ tonicMidi: 60, fits: true });
  });
});

describe("scaleMidi", () => {
  it("ascends one octave from the tonic in every key", () => {
    for (const key of ALL_KEYS) {
      const t = tonicMidiAt(key, 3);
      const s = scaleMidi(key, t);
      expect(s).toHaveLength(8);
      expect(s[0]).toBe(t);
      expect(s[7]).toBe(t + 12);
      for (let i = 1; i < 8; i++) expect(at(s, i) - at(s, i - 1)).toBeGreaterThan(0);
    }
  });
});

describe("cadence", () => {
  it("has the right roman numerals", () => {
    for (const key of ALL_KEYS) {
      const romans = cadence(key).chords.map((ch) => ch.roman);
      expect(romans).toEqual(key.mode === "major" ? ["I", "IV", "V", "I"] : ["i", "iv", "V", "i"]);
    }
  });

  it("contains the raised 7th in minor V and the b3 in minor i", () => {
    for (const [tonic, row] of Object.entries(MINOR_TABLE)) {
      const key = makeKey(tonic, "minor");
      const t = tonicMidiAt(key, 4);
      const chords = cadence(key).chords;
      const leadingPc = ((degreeToMidi(key, 7, t, { minorVariant: "harmonic" }) % 12) + 12) % 12;
      const naturalPc = ((degreeToMidi(key, 7, t) % 12) + 12) % 12;
      const vPcs = (chords[2] as { upper: number[] }).upper.map((n) => n % 12);
      expect(vPcs, `${tonic} V (${row.leading})`).toContain(leadingPc);
      expect(vPcs).not.toContain(naturalPc);
      const iPcs = (chords[0] as { upper: number[] }).upper.map((n) => n % 12);
      expect(iPcs).toContain(degreeToMidi(key, 3, t) % 12);
    }
  });

  it("builds the expected C major voicing", () => {
    const { chords } = cadence(makeKey("C", "major"));
    for (const ch of chords) {
      expect(ch.bass).toBeGreaterThanOrEqual(36);
      expect(ch.bass).toBeLessThanOrEqual(48);
    }
    expect(chords.map((ch) => ch.bass % 12)).toEqual([0, 5, 7, 0]);
    expect(chords.map((ch) => ch.upper.map((n) => n % 12).sort((a, b) => a - b))).toEqual([
      [0, 4, 7],
      [0, 5, 9],
      [2, 7, 11],
      [0, 4, 7],
    ]);
  });

  const upperRanges: VoiceRange[] = [
    { low: 55, high: 76 },
    { low: 52, high: 72 },
    { low: 60, high: 79 },
    { low: 50, high: 67 },
    { low: 57, high: 75 },
    { low: 50, high: 66 },
  ];
  const bassRanges: VoiceRange[] = [
    { low: 36, high: 48 },
    { low: 33, high: 47 },
    { low: 36, high: 47 },
    { low: 28, high: 45 },
  ];

  it("stays within ranges, never crosses, leaps at most a fourth, and is deterministic", () => {
    fc.assert(
      fc.property(
        keyArb,
        fc.constantFrom(...upperRanges),
        fc.constantFrom(...bassRanges),
        (key, upperRange, bassRange) => {
          const a = cadence(key, { upperRange, bassRange });
          expect(cadence(key, { upperRange, bassRange })).toEqual(a);
          expect(a.chords).toHaveLength(4);
          a.chords.forEach((ch, i) => {
            expect(ch.bass).toBeGreaterThanOrEqual(bassRange.low);
            expect(ch.bass).toBeLessThanOrEqual(bassRange.high);
            expect(ch.upper).toHaveLength(3);
            for (const n of ch.upper) {
              expect(n).toBeGreaterThanOrEqual(upperRange.low);
              expect(n).toBeLessThanOrEqual(upperRange.high);
            }
            // no voice crossing: strictly ascending, bass below all
            expect(at(ch.upper, 0)).toBeGreaterThan(ch.bass);
            expect(at(ch.upper, 1)).toBeGreaterThan(at(ch.upper, 0));
            expect(at(ch.upper, 2)).toBeGreaterThan(at(ch.upper, 1));
            // close position: within an octave
            expect(at(ch.upper, 2) - at(ch.upper, 0)).toBeLessThan(12);
            if (i > 0) {
              const prev = at(a.chords, i - 1);
              ch.upper.forEach((n, v) => {
                expect(Math.abs(n - at(prev.upper, v))).toBeLessThanOrEqual(MAX_VOICE_LEAP);
              });
            }
          });
        },
      ),
      { numRuns: 300 },
    );
  });

  it("throws on ranges that cannot hold the cadence", () => {
    const k = makeKey("C", "major");
    expect(() => cadence(k, { upperRange: { low: 60, high: 64 } })).toThrow(RangeError);
    expect(() => cadence(k, { bassRange: { low: 36, high: 40 } })).toThrow(RangeError);
    expect(() => cadence(k, { bassRange: { low: 60, high: 72 } })).toThrow(RangeError);
  });
});
