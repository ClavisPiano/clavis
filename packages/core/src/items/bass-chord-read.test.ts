import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { SkillNode } from "../graph/schema.js";
import { createRng } from "../random.js";
import { ScoreSpecSchema, scoreNoteIds, spelledToMidi } from "../score/schema.js";
import { StimulusSpecSchema } from "../stimulus/types.js";
import {
  keyFamily,
  keysInFamilies,
  tonicChroma,
  type Key,
  type KeyFamily,
} from "../theory/keys.js";
import {
  formatStaffPosition,
  staffPosition,
  writtenAccidental,
  type StaffPosition,
} from "../theory/staff.js";
import { at } from "../theory/util.js";
import {
  BASS_CHORD_WINDOW_MS,
  CHORD_STAFF_HIGH,
  CHORD_STAFF_LOW,
  bassChord,
  bassChordRead,
  bassChordRegisters,
  type BassChordInversion,
} from "./bass-chord-read.js";
import { ExpectedResponseSchema } from "./expected.js";
import { itemId } from "./ids.js";
import { getGenerator } from "./registry.js";
import type { GenerateContext, ItemParams } from "./types.js";

const NODE_ID = "read.bass.chords";
const node: SkillNode = {
  id: NODE_ID,
  strand: "READ",
  title: "Bass chords",
  prerequisites: ["read.bass.skips", "hands.lh.triads.root"],
  itemGenerators: ["bassChordRead"],
  params: { clef: "bass", qualities: ["major", "minor"], inversions: ["root", "first", "second"] },
  mastery: { minAccuracy: 0.9, maxMedianLatencyMs: 3000, windowAttempts: 20, distinctSessions: 2 },
  keyDependent: true,
  targetLatencyMs: 3000,
};

const FAMILIES: readonly KeyFamily[] = ["A", "B", "C"];
const ROMANS = ["I", "ii", "iii", "IV", "V", "vi"] as const;
const INVERSIONS: readonly BassChordInversion[] = ["root", "first", "second"];
const majorKeysOf = (fam: KeyFamily): Key[] =>
  keysInFamilies([fam]).filter((k) => k.mode === "major");
const MAJOR_KEYS = FAMILIES.flatMap(majorKeysOf);

/**
 * Semitones above the tonic of root, third and fifth, from the major scale, written out here so the
 * test does not reuse the generator's own theory.
 */
const TRIADS: Record<string, [number, number, number]> = {
  I: [0, 4, 7],
  ii: [2, 5, 9],
  iii: [4, 7, 11],
  IV: [5, 9, 0],
  V: [7, 11, 2],
  vi: [9, 0, 4],
};
/** Which chord member is in the bass: root, third or fifth. */
const BASS_MEMBER: Record<BassChordInversion, number> = { root: 0, first: 1, second: 2 };
/** Letters of the root above the tonic's letter, for each numeral. */
const DEGREE: Record<string, number> = { I: 0, ii: 1, iii: 2, IV: 3, V: 4, vi: 5 };
const LETTERS = "CDEFGAB";

const ctx = (seed: number, preferredKey?: Key): GenerateContext => ({
  rng: createRng(seed),
  voiceRange: { low: 48, high: 72 },
  mode: "instrument",
  ...(preferredKey === undefined ? {} : { preferredKey }),
});
const pc = (m: number, key: Key): number => (((m - tonicChroma(key)) % 12) + 12) % 12;
const lo = staffPosition(CHORD_STAFF_LOW);
const hi = staffPosition(CHORD_STAFF_HIGH);

describe("bassChordRead universe", () => {
  it("is every major and minor diatonic triad in every inversion, per key family", () => {
    const items = bassChordRead.listItems(node);
    expect(items).toHaveLength(3 * 6 * 3);
    expect(items[0]).toEqual({ fam: "A", roman: "I", inv: "root" });
    expect(bassChordRead.listItems(node)).toEqual(items);
    expect(new Set(items.map((p) => itemId(NODE_ID, p))).size).toBe(items.length);
    expect(new Set(items.map((p) => p.roman))).toEqual(new Set(ROMANS));
    expect(itemId(NODE_ID, { fam: "A", roman: "ii", inv: "first" })).toBe(
      `${NODE_ID}|fam=A|inv=first|roman=ii`,
    );
  });

  it("follows the node params", () => {
    const majorRoot: SkillNode = {
      ...node,
      params: { clef: "bass", qualities: ["major"], inversions: ["root"] },
    };
    expect(bassChordRead.listItems(majorRoot).map((p) => p.roman)).toEqual([
      "I",
      "IV",
      "V",
      "I",
      "IV",
      "V",
      "I",
      "IV",
      "V",
    ]);
    expect(() =>
      bassChordRead.generate(majorRoot, { fam: "A", roman: "ii", inv: "root" }, ctx(1)),
    ).toThrow(/not in node/);
    expect(() =>
      bassChordRead.generate(majorRoot, { fam: "A", roman: "I", inv: "first" }, ctx(1)),
    ).toThrow(/not in node/);
  });

  it("is registered and rejects unknown numerals and other nodes", () => {
    expect(getGenerator("bassChordRead")).toBe(bassChordRead);
    expect(() =>
      bassChordRead.generate(node, { fam: "A", roman: "vii", inv: "root" }, ctx(1)),
    ).toThrow(/not in node/);
    expect(() => bassChordRead.listItems({ ...node, params: { clef: "treble" } })).toThrow();
  });
});

describe("bassChord spelling", () => {
  // Every major key of every family, every chord, every inversion, every register.
  const cases = FAMILIES.flatMap((fam) =>
    majorKeysOf(fam).flatMap((key) =>
      ROMANS.flatMap((roman) => INVERSIONS.map((inv) => [fam, key.tonic, roman, inv] as const)),
    ),
  );

  it.each(cases)("family %s, %s major, %s in %s inversion", (_fam, tonic, roman, inv) => {
    const key: Key = { tonic, mode: "major" };
    const registers = bassChordRegisters(key, roman, inv);
    // At least one register, and the C2 to C4 window leaves room for at most two.
    expect(registers.length).toBeGreaterThanOrEqual(1);
    expect(registers.length).toBeLessThanOrEqual(2);
    for (const bass of registers) {
      const c = bassChord(key, roman, inv, bass);
      const triad = TRIADS[roman] ?? [];
      // Right pitch classes, the right member in the bass, lowest first, in close position.
      expect(new Set(c.midi.map((m) => pc(m, key)))).toEqual(new Set(triad));
      expect(pc(at(c.midi, 0), key)).toBe(triad[BASS_MEMBER[inv]]);
      expect([...c.midi].sort((a, b) => a - b)).toEqual(c.midi);
      expect(at(c.midi, 2) - at(c.midi, 0)).toBeLessThan(12);
      expect(c.pitches.map(spelledToMidi)).toEqual(c.midi);
      // Spelled as thirds on the root's letter: the letters are root, third and fifth of the
      // scale degree, and the key signature gives every alteration.
      const rootLetter = (LETTERS.indexOf(tonic.charAt(0)) + (DEGREE[roman] ?? 0)) % 7;
      const memberLetters = [0, 2, 4].map((n) => LETTERS.charAt((rootLetter + n) % 7));
      const order = { root: [0, 1, 2], first: [1, 2, 0], second: [2, 0, 1] }[inv];
      expect(c.pitches.map((p) => p.step)).toEqual(order.map((i) => memberLetters[i]));
      for (const p of c.pitches) expect(writtenAccidental(p, key)).toBeUndefined();
      // Every tone between E2 and middle C on the staff.
      for (const pos of c.positions) {
        expect(staffPosition(pos)).toBeGreaterThanOrEqual(lo);
        expect(staffPosition(pos)).toBeLessThanOrEqual(hi);
      }
      expect(formatStaffPosition(at(c.positions, 0))).toBe(formatStaffPosition(bass));
    }
  });

  it("names chords by root and quality, with the bass after a slash when inverted", () => {
    const C: Key = { tonic: "C", mode: "major" };
    const reg = (key: Key, roman: string, inv: BassChordInversion): StaffPosition =>
      at(bassChordRegisters(key, roman, inv), 0);
    const sym = (key: Key, roman: string, inv: BassChordInversion): string =>
      bassChord(key, roman, inv, reg(key, roman, inv)).symbol;
    expect(sym(C, "I", "root")).toBe("C");
    expect(sym(C, "ii", "first")).toBe("Dm/F");
    expect(sym(C, "V", "second")).toBe("G/D");
    expect(sym({ tonic: "Eb", mode: "major" }, "vi", "first")).toBe("Cm/Eb");
    expect(sym({ tonic: "F#", mode: "major" }, "vi", "root")).toBe("D#m");
    expect(sym({ tonic: "Db", mode: "major" }, "IV", "second")).toBe("Gb/Db");
    // C major, IV in first inversion, from the lower register: A2 C3 F3.
    expect(bassChord(C, "IV", "first", { step: "A", octave: 2 }).midi).toEqual([45, 48, 53]);
  });

  it("refuses a minor key", () => {
    expect(() =>
      bassChord({ tonic: "A", mode: "minor" }, "I", "root", { step: "A", octave: 2 }),
    ).toThrow(RangeError);
  });
});

describe("bassChordRead generate", () => {
  const items = bassChordRead.listItems(node);

  it("has an id that is stable across keys and registers, and carries the family", () => {
    const params: ItemParams = { fam: "B", roman: "V", inv: "second" };
    const ids = new Set(
      majorKeysOf("B").flatMap((key) =>
        [1, 2, 3, 4].map((seed) => bassChordRead.generate(node, params, ctx(seed, key)).itemId),
      ),
    );
    expect([...ids]).toEqual([`${NODE_ID}|fam=B|inv=second|roman=V`]);
  });

  it("plays in the preferred key when it is in the item's family, else a key of that family", () => {
    for (const fam of FAMILIES) {
      for (const key of MAJOR_KEYS) {
        const inst = bassChordRead.generate(node, { fam, roman: "I", inv: "root" }, ctx(3, key));
        const k = inst.presentation.key as unknown as Key;
        expect(keyFamily(k)).toBe(fam);
        expect(k.mode).toBe("major");
        if (keyFamily(key) === fam) expect(k).toEqual(key);
      }
    }
  });

  it("uses every register the staff allows, chosen by seed", () => {
    const key: Key = { tonic: "C", mode: "major" };
    // First inversion of I: E2 G2 C3 or E3 G3 C4.
    const params = { fam: "A", roman: "I", inv: "first" };
    const seen = new Set<string>();
    for (let seed = 0; seed < 40; seed++) {
      const bass = bassChordRead.generate(node, params, ctx(seed, key)).presentation.bass;
      if (typeof bass !== "string") throw new Error("expected the bass position");
      seen.add(bass);
    }
    expect([...seen].sort()).toEqual(
      bassChordRegisters(key, "I", "first").map(formatStaffPosition),
    );
    expect([...seen].sort()).toEqual(["E2", "E3"]);
  });

  it("is a valid, replayable reading item for every item in every key", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: items.length - 1 }),
        fc.integer({ min: 0, max: 1000 }),
        fc.constantFrom(...MAJOR_KEYS),
        (idx, seed, preferred) => {
          const params = at(items, idx);
          const a = bassChordRead.generate(node, params, ctx(seed, preferred));
          expect(bassChordRead.generate(node, params, ctx(seed, preferred))).toEqual(a);
          expect(a.itemId).toBe(itemId(NODE_ID, params));
          expect(a.params).toEqual(params);
          expect(a.generator).toBe("bassChordRead");
          ExpectedResponseSchema.parse(a.expected);
          StimulusSpecSchema.parse(a.stimulus);
          const display = ScoreSpecSchema.parse(a.display);

          // One chord, graded on its tones only, with its labels hidden while playing.
          const play = a.expected.play;
          if (play?.kind !== "chordLine") throw new Error("expected a chord line");
          expect(play.chords).toHaveLength(1);
          expect(play.gradeTiming).toBe(false);
          expect(play.showLabels).toBe(false);
          const chord = at(play.chords, 0);
          expect(chord.roman).toBe(params.roman);
          expect(chord.onsetBeats).toBe(0);
          const key = a.presentation.key as unknown as Key;
          expect(new Set(chord.midi.map((m) => pc(m, key)))).toEqual(
            new Set(TRIADS[params.roman as string]),
          );

          // Display: the same chord as one whole note on the bass staff, no meter, no accidental.
          expect(scoreNoteIds(display)).toEqual(["n1"]);
          expect(display.staves).toHaveLength(1);
          expect(display.staves[0]?.clef).toBe("bass");
          expect(display.meter).toBeNull();
          expect(display.key).toEqual(key);
          const note = display.staves[0]?.measures[0]?.[0];
          if (note?.kind !== "note") throw new Error("expected a note");
          expect(note.pitches.map(spelledToMidi)).toEqual(chord.midi);
          expect(note.duration).toEqual({ value: 1, dots: 0 });
          expect(note.accidental).toBeUndefined();

          // No sound first (R17): latency runs from the score being shown.
          expect(a.stimulus.events).toEqual([]);
          expect(a.expected.responseWindowMs).toBe(BASS_CHORD_WINDOW_MS);
          expect(a.targetLatencyMs).toBe(3000);
          expect(a.inputRange?.low).toBeLessThanOrEqual(Math.min(...chord.midi));
          expect(a.inputRange?.high).toBeGreaterThanOrEqual(Math.max(...chord.midi));

          // The presentation replays it (R2).
          expect(a.presentation.midi).toEqual(chord.midi);
          expect(a.presentation.prog).toEqual([chord.roman]);
          expect(a.presentation.symbols).toEqual([chord.symbol]);
          expect(a.presentation.fam).toBe(params.fam);
          expect(typeof a.presentation.seed).toBe("number");
        },
      ),
      { numRuns: 300 },
    );
  });
});
