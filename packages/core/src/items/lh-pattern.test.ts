import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { SkillNode } from "../graph/schema.js";
import { createRng } from "../random.js";
import { ScoreSpecSchema, scoreNoteIds, spelledToMidi } from "../score/schema.js";
import { StimulusSpecSchema } from "../stimulus/types.js";
import { MAJOR_ROMAN_ROOTS } from "../theory/cadence.js";
import { keyFamily, tonicChroma, type Key } from "../theory/keys.js";
import { ALL_KEYS } from "../theory/keys.js";
import { at } from "../theory/util.js";
import { enumerateBassMotions } from "./bass-motion.js";
import { ExpectedResponseSchema } from "./expected.js";
import { itemId } from "./ids.js";
import { LH_RANGE, LH_TEMPO_BPM, lhChords, lhPattern, lhResponseWindowMs } from "./lh-pattern.js";
import { getGenerator } from "./registry.js";
import type { GenerateContext, ItemParams } from "./types.js";

const NODE_ID = "hands.lh.triads.root";
const node: SkillNode = {
  id: NODE_ID,
  strand: "HANDS",
  title: "Root-position triads",
  prerequisites: [],
  itemGenerators: ["lhPattern"],
  params: { pattern: "block", chords: ["I", "IV", "V", "vi"], inversion: "root" },
  mastery: { minAccuracy: 0.8, windowAttempts: 5, distinctSessions: 2 },
  keyDependent: true,
};

const MAJOR_KEYS = ALL_KEYS.filter((k) => k.mode === "major");
const ctx = (seed: number, preferredKey?: Key): GenerateContext => ({
  rng: createRng(seed),
  mode: "instrument",
  ...(preferredKey === undefined ? {} : { preferredKey }),
});

/** Semitones of the root, third and fifth above the tonic for each numeral. */
const OFFSETS: Record<string, number[]> = {
  I: [0, 4, 7],
  IV: [5, 9, 0],
  V: [7, 11, 2],
  vi: [9, 0, 4],
};

describe("lhPattern universe", () => {
  it("is the bass motion progressions in each key family, in a stable order", () => {
    const items = lhPattern.listItems(node);
    const progs = enumerateBassMotions(["I", "IV", "V", "vi"]);
    expect(items).toHaveLength(3 * progs.length);
    expect(items[0]).toEqual({ fam: "A", prog: ["I", "IV", "I", "IV"] });
    expect(lhPattern.listItems(node)).toEqual(items);
    for (const it of items)
      expect(it.prog).toSatisfy((p: unknown) => Array.isArray(p) && p[0] === "I");
    expect(new Set(items.map((p) => itemId(NODE_ID, p))).size).toBe(items.length);
  });

  it("is registered and rejects nodes that are not the root-position node", () => {
    expect(getGenerator("lhPattern")).toBe(lhPattern);
    const other: SkillNode = { ...node, params: { pattern: "broken" } };
    expect(() => lhPattern.listItems(other)).toThrow();
  });

  it("rejects a progression with a chord outside the node", () => {
    expect(() =>
      lhPattern.generate(node, { fam: "A", prog: ["I", "ii", "V", "I"] }, ctx(1)),
    ).toThrow(/not in node/);
  });
});

describe("lhChords", () => {
  it.each(MAJOR_KEYS.map((k) => [k.tonic, k] as const))(
    "%s major: chord tones match the numerals and stay in the left-hand register",
    (_t, key) => {
      const prog = ["I", "IV", "V", "vi", "I", "V", "IV", "vi"];
      const chords = lhChords(key, prog);
      const tonic = tonicChroma(key);
      chords.forEach((c, i) => {
        const roman = at(prog, i);
        expect(c.roman).toBe(roman);
        expect(c.midi.map((m) => (((m - tonic) % 12) + 12) % 12)).toEqual(OFFSETS[roman]);
        // Root position: stacked thirds, lowest first.
        expect([...c.midi].sort((a, b) => a - b)).toEqual(c.midi);
        for (const m of c.midi) {
          expect(m).toBeGreaterThanOrEqual(LH_RANGE.low);
          expect(m).toBeLessThanOrEqual(LH_RANGE.high);
        }
        expect(c.pitches.map(spelledToMidi)).toEqual(c.midi);
        // The root's letter is the degree's letter above the tonic's.
        const degree = MAJOR_ROMAN_ROOTS[roman] ?? 0;
        const tonicLetter = "CDEFGAB".indexOf(key.tonic.charAt(0));
        expect(at(c.pitches, 0).step).toBe("CDEFGAB".charAt((tonicLetter + degree - 1) % 7));
      });
    },
  );

  it("names chords: major triads by their root, minor with an m", () => {
    expect(
      lhChords({ tonic: "C", mode: "major" }, ["I", "IV", "V", "vi"]).map((c) => c.symbol),
    ).toEqual(["C", "F", "G", "Am"]);
    expect(
      lhChords({ tonic: "Eb", mode: "major" }, ["I", "IV", "V", "vi"]).map((c) => c.symbol),
    ).toEqual(["Eb", "Ab", "Bb", "Cm"]);
    expect(
      lhChords({ tonic: "F#", mode: "major" }, ["I", "IV", "V", "vi"]).map((c) => c.symbol),
    ).toEqual(["F#", "B", "C#", "D#m"]);
  });

  it("moves the hand little: roots are less than an octave apart", () => {
    for (const key of MAJOR_KEYS) {
      const chords = lhChords(key, ["I", "vi", "IV", "V"]);
      for (let i = 1; i < chords.length; i++) {
        const gap = Math.abs(at(at(chords, i).midi, 0) - at(at(chords, i - 1).midi, 0));
        expect(gap).toBeLessThan(12);
      }
    }
  });

  it("refuses a minor key", () => {
    expect(() => lhChords({ tonic: "A", mode: "minor" }, ["I"])).toThrow(RangeError);
  });
});

describe("lhPattern generate", () => {
  const items = lhPattern.listItems(node);

  it("has an id that is stable across keys, and carries the family but not the key", () => {
    const params: ItemParams = { fam: "A", prog: ["I", "IV", "V", "I"] };
    const ids = new Set(
      MAJOR_KEYS.filter((k) => keyFamily(k) === "A").map(
        (key) => lhPattern.generate(node, params, ctx(3, key)).itemId,
      ),
    );
    expect([...ids]).toEqual([`${NODE_ID}|fam=A|prog=I-IV-V-I`]);
  });

  it("uses the preferred key when it is in the item's family, else a key of that family", () => {
    const g = { tonic: "G", mode: "major" } as const;
    expect(
      lhPattern.generate(node, { fam: "A", prog: ["I", "IV", "V", "I"] }, ctx(1, g)).presentation
        .tonic,
    ).toBe("G");
    const c = lhPattern.generate(node, { fam: "C", prog: ["I", "IV", "V", "I"] }, ctx(1, g));
    expect(keyFamily(c.presentation.key as unknown as Key)).toBe("C");
  });

  it("is a valid, replayable item for every item of every key", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: items.length - 1 }),
        fc.integer({ min: 0, max: 1000 }),
        fc.constantFrom(...MAJOR_KEYS),
        (idx, seed, preferred) => {
          const params = at(items, idx);
          const a = lhPattern.generate(node, params, ctx(seed, preferred));
          const b = lhPattern.generate(node, params, ctx(seed, preferred));
          expect(b).toEqual(a);
          expect(a.itemId).toBe(itemId(NODE_ID, params));
          expect(a.params).toEqual(params);
          expect(a.generator).toBe("lhPattern");

          ExpectedResponseSchema.parse(a.expected);
          StimulusSpecSchema.parse(a.stimulus);
          const display = ScoreSpecSchema.parse(a.display);
          const play = a.expected.play;
          if (play?.kind !== "chordLine") throw new Error("expected a chord line");

          // Display and expectation agree: one stacked chord per ScoreNote, in order.
          expect(scoreNoteIds(display)).toEqual(["n1", "n2", "n3", "n4"]);
          expect(display.staves[0]?.clef).toBe("bass");
          const written = display.staves[0]?.measures
            .flat()
            .map((el) => (el.kind === "note" ? el.pitches.map(spelledToMidi) : []));
          expect(written).toEqual(play.chords.map((c) => c.midi));
          expect(display.meter).toEqual({ beats: 4, beatValue: 4 });

          // Chord tones fit the numerals in the key, and all sit in the left-hand register.
          const key = a.presentation.key as { tonic: string; mode: "major" };
          expect(play.chords.map((c) => c.roman)).toEqual(params.prog);
          play.chords.forEach((c, i) => {
            const roman = at(params.prog as string[], i);
            expect(c.midi.map((m) => (((m - tonicChroma(key)) % 12) + 12) % 12)).toEqual(
              OFFSETS[roman],
            );
            for (const m of c.midi) {
              expect(m).toBeGreaterThanOrEqual(LH_RANGE.low);
              expect(m).toBeLessThanOrEqual(LH_RANGE.high);
            }
            expect(c.onsetBeats).toBe(i * 2);
          });
          expect(play.tempoBpm).toBe(LH_TEMPO_BPM);

          // The presentation carries everything needed to replay it (R2).
          expect(a.presentation.chords).toEqual(play.chords.map((c) => c.midi));
          expect(a.presentation.symbols).toEqual(play.chords.map((c) => c.symbol));
          expect(a.presentation.prog).toEqual(params.prog);
          expect(a.presentation.tempoBpm).toBe(LH_TEMPO_BPM);
          expect(typeof a.presentation.seed).toBe("number");

          // A count-in, no audio of the answer (R17), and a keyboard range around the chords.
          expect(a.stimulus.events.every((e) => e.role === "count-in")).toBe(true);
          expect(a.stimulus.events).toHaveLength(4);
          const all = play.chords.flatMap((c) => c.midi);
          expect(a.inputRange?.low).toBeLessThan(Math.min(...all));
          expect(a.inputRange?.high).toBeGreaterThan(Math.max(...all));
          expect(a.expected.responseWindowMs).toBe(lhResponseWindowMs(8, LH_TEMPO_BPM));
        },
      ),
      { numRuns: 200 },
    );
  });

  it("writes no accidentals: every tone is in the key signature", () => {
    for (const key of MAJOR_KEYS) {
      const inst = lhPattern.generate(
        node,
        { fam: keyFamily(key), prog: ["I", "IV", "V", "vi"] },
        ctx(5, key),
      );
      for (const el of inst.display?.staves[0]?.measures.flat() ?? []) {
        if (el.kind === "note") expect(el.accidental).toBeUndefined();
      }
    }
  });
});
