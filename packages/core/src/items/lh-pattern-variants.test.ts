import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { SkillNode } from "../graph/schema.js";
import { createRng } from "../random.js";
import { ScoreSpecSchema, scoreNoteIds, spelledToMidi } from "../score/schema.js";
import { StimulusSpecSchema } from "../stimulus/types.js";
import { ALL_KEYS, keyFamily, tonicChroma, type Key } from "../theory/keys.js";
import { at } from "../theory/util.js";
import { enumerateBassMotions } from "./bass-motion.js";
import { ExpectedResponseSchema } from "./expected.js";
import { itemId } from "./ids.js";
import { LH_RANGE, LH_TEMPO_BPM, lhChords, lhPattern, lhResponseWindowMs } from "./lh-pattern.js";
import {
  INVERSIONS,
  LINE_PATTERNS,
  closeVoicings,
  lhPatternVariants,
  patternLine,
  type LinePattern,
} from "./lh-pattern-variants.js";
import { getGenerator } from "./registry.js";
import type { GenerateContext, ItemInstance, ItemParams } from "./types.js";

const CHORDS = ["I", "IV", "V", "vi"];
const mastery = { minAccuracy: 0.8, windowAttempts: 5, distinctSessions: 2 };
const hands = (id: string, params: SkillNode["params"]): SkillNode => ({
  id,
  strand: "HANDS",
  title: id,
  prerequisites: [],
  itemGenerators: ["lhPatternVariants"],
  params,
  mastery,
  keyDependent: true,
});
const INV = hands("hands.lh.inversions", {
  pattern: "block",
  voiceLeading: "close",
  inversions: ["root", "first", "second"],
  chords: CHORDS,
});
const BROKEN = hands("hands.lh.broken", { patterns: ["broken", "alberti"], chords: CHORDS });
const POP = hands("hands.lh.pop", { patterns: ["root-5-8", "syncopated"], chords: CHORDS });

const MAJOR_KEYS = ALL_KEYS.filter((k) => k.mode === "major");
const PROGS = enumerateBassMotions(CHORDS);
const ctx = (seed: number, preferredKey?: Key): GenerateContext => ({
  rng: createRng(seed),
  mode: "instrument",
  ...(preferredKey === undefined ? {} : { preferredKey }),
});

/** Pitch classes (semitones above the tonic) of each numeral's triad. */
const TRIAD: Record<string, number[]> = {
  I: [0, 4, 7],
  IV: [5, 9, 0],
  V: [7, 11, 2],
  vi: [9, 0, 4],
};
const pc = (m: number, key: Key): number => (((m - tonicChroma(key)) % 12) + 12) % 12;
const inRange = (m: number): boolean => m >= LH_RANGE.low && m <= LH_RANGE.high;

/** Semitones each pattern note sits above the root: the triad is major or minor, fifth perfect. */
const STEP_SEMITONES = (roman: string): Record<number, number> => ({
  0: 0,
  2: roman === roman.toLowerCase() ? 3 : 4,
  4: 7,
  7: 12,
});
const PATTERN_STEPS: Record<LinePattern, number[]> = {
  broken: [0, 2, 4, 2],
  alberti: [0, 4, 2, 4],
  "root-5-8": [0, 4, 7],
  syncopated: [0, 4, 7],
};
const PATTERN_ONSETS: Record<LinePattern, number[]> = {
  broken: [0, 0.5, 1, 1.5],
  alberti: [0, 0.5, 1, 1.5],
  "root-5-8": [0, 1, 1.5],
  syncopated: [0, 0.5, 1.5],
};

describe("lhPatternVariants universe", () => {
  it("is registered", () => {
    expect(getGenerator("lhPatternVariants")).toBe(lhPatternVariants);
  });

  it("gives inversions the lhPattern universe: progressions times families", () => {
    const items = lhPatternVariants.listItems(INV);
    expect(items).toHaveLength(3 * PROGS.length);
    expect(items).toEqual(
      lhPattern.listItems({
        ...INV,
        params: { pattern: "block", chords: CHORDS, inversion: "root" },
      }),
    );
    expect(itemId(INV.id, at(items, 0))).toBe("hands.lh.inversions|fam=A|prog=I-IV-I-IV");
  });

  it.each([
    [BROKEN, ["broken", "alberti"]],
    [POP, ["root-5-8", "syncopated"]],
  ] as const)("puts the pattern in the id for $id", (node, patterns) => {
    const items = lhPatternVariants.listItems(node);
    expect(items).toHaveLength(3 * patterns.length * PROGS.length);
    expect(new Set(items.map((p) => itemId(node.id, p))).size).toBe(items.length);
    expect(new Set(items.map((p) => p.pattern))).toEqual(new Set(patterns));
    expect(itemId(node.id, at(items, 0))).toBe(
      `${node.id}|fam=A|pattern=${patterns[0]}|prog=I-IV-I-IV`,
    );
    expect(lhPatternVariants.listItems(node)).toEqual(items);
  });

  it("rejects unknown node params, chords outside the node and patterns outside the node", () => {
    expect(() =>
      lhPatternVariants.listItems(
        hands("hands.minor.leadingTone", {
          mode: "harmonic-minor",
          chords: ["i", "iv", "V"],
          raised: 7,
        }),
      ),
    ).toThrow();
    expect(() =>
      lhPatternVariants.generate(INV, { fam: "A", prog: ["I", "ii", "V", "I"] }, ctx(1)),
    ).toThrow(/not in node/);
    expect(() =>
      lhPatternVariants.generate(
        BROKEN,
        { fam: "A", pattern: "root-5-8", prog: ["I", "IV", "V", "I"] },
        ctx(1),
      ),
    ).toThrow(/not in node/);
    expect(() =>
      lhPatternVariants.generate(BROKEN, { fam: "A", prog: ["I", "IV", "V", "I"] }, ctx(1)),
    ).toThrow();
  });
});

describe("closeVoicings", () => {
  it.each(MAJOR_KEYS.map((k) => [k.tonic, k] as const))(
    "%s major: every progression moves each voice at most a fourth, within C2 to C4",
    (_t, key) => {
      for (const prog of PROGS) {
        const chords = closeVoicings(key, prog);
        chords.forEach((c, i) => {
          const roman = at(prog, i);
          expect(c.roman).toBe(roman);
          // The right tones, each once, lowest first, as close as a triad goes (under an octave).
          expect(new Set(c.midi.map((m) => pc(m, key)))).toEqual(new Set(TRIAD[roman]));
          expect([...c.midi].sort((a, b) => a - b)).toEqual(c.midi);
          expect(at(c.midi, 2) - at(c.midi, 0)).toBeLessThan(12);
          expect(c.midi.every(inRange)).toBe(true);
          expect(c.pitches.map(spelledToMidi)).toEqual(c.midi);
          // The inversion names the chord tone in the bass.
          const bassTone = [0, 1, 2].find((t) => pc(at(c.midi, 0), key) === TRIAD[roman]?.[t]);
          expect(INVERSIONS[bassTone ?? -1]).toBe(c.inversion);
          if (i === 0) return;
          const prev = at(chords, i - 1);
          for (let v = 0; v < 3; v++) {
            expect(Math.abs(at(c.midi, v) - at(prev.midi, v))).toBeLessThanOrEqual(5);
          }
        });
        // It starts where the root-position node starts.
        expect(at(chords, 0).midi).toEqual(at(lhChords(key, prog), 0).midi);
      }
    },
  );

  it("keeps common tones: I-IV-V-I in C is C E G, C F A, B D G, C E G", () => {
    const chords = closeVoicings({ tonic: "C", mode: "major" }, ["I", "IV", "V", "I"]);
    expect(chords.map((c) => c.midi)).toEqual([
      [48, 52, 55],
      [48, 53, 57],
      [47, 50, 55],
      [48, 52, 55],
    ]);
    expect(chords.map((c) => c.inversion)).toEqual(["root", "second", "first", "root"]);
    expect(chords.map((c) => c.symbol)).toEqual(["C", "F/C", "G/B", "C"]);
  });

  it("uses inversions at all: across the universe in C every inversion appears", () => {
    const seen = new Set(
      PROGS.flatMap((p) => closeVoicings({ tonic: "C", mode: "major" }, p).map((c) => c.inversion)),
    );
    expect(seen).toEqual(new Set(INVERSIONS));
  });

  it("only uses the inversions it is allowed", () => {
    const chords = closeVoicings({ tonic: "D", mode: "major" }, ["I", "vi", "IV", "V"], ["first"]);
    expect(chords.every((c) => c.inversion === "first")).toBe(true);
  });
});

describe("patternLine", () => {
  it.each(LINE_PATTERNS.map((p) => [p] as const))(
    "%s: the right chord tones on the right eighths, within C2 to C4 in every key",
    (pattern) => {
      for (const key of MAJOR_KEYS) {
        for (const prog of PROGS) {
          const { chords, notes } = patternLine(key, prog, pattern);
          const steps = PATTERN_STEPS[pattern];
          expect(notes).toHaveLength(steps.length * 4);
          notes.forEach((n, i) => {
            const ci = Math.floor(i / steps.length);
            const roman = at(prog, ci);
            const root = at(at(chords, ci).midi, 0);
            expect(n.chord).toBe(ci);
            expect(n.midi - root).toBe(STEP_SEMITONES(roman)[at(steps, i % steps.length)]);
            expect(n.onsetBeats).toBe(ci * 2 + at(PATTERN_ONSETS[pattern], i % steps.length));
            expect(spelledToMidi(n.pitch)).toBe(n.midi);
            expect(inRange(n.midi)).toBe(true);
          });
          expect(pc(at(at(chords, 0).midi, 0), key)).toBe(0);
        }
      }
    },
  );
});

describe("lhPatternVariants generate", () => {
  const cases: [SkillNode, ItemParams[]][] = [INV, BROKEN, POP].map((n) => [
    n,
    lhPatternVariants.listItems(n),
  ]);

  it("has ids stable across the keys of a family, with the family and not the key", () => {
    for (const [node, items] of cases) {
      const params = at(items, 5);
      const ids = new Set(
        MAJOR_KEYS.filter((k) => keyFamily(k) === params.fam).map(
          (key) => lhPatternVariants.generate(node, params, ctx(3, key)).itemId,
        ),
      );
      expect([...ids]).toEqual([itemId(node.id, params)]);
    }
  });

  it("is a valid, replayable item for every node, item and key", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...cases),
        fc.nat(),
        fc.integer({ min: 0, max: 1000 }),
        fc.constantFrom(...MAJOR_KEYS),
        ([node, items], n, seed, preferred) => {
          const params = at(items, n % items.length);
          const a = lhPatternVariants.generate(node, params, ctx(seed, preferred));
          expect(lhPatternVariants.generate(node, params, ctx(seed, preferred))).toEqual(a);
          expect(a.itemId).toBe(itemId(node.id, params));
          expect(a.params).toEqual(params);
          expect(a.generator).toBe("lhPatternVariants");
          ExpectedResponseSchema.parse(a.expected);
          StimulusSpecSchema.parse(a.stimulus);
          const display = ScoreSpecSchema.parse(a.display);
          expect(display.staves[0]?.clef).toBe("bass");
          expect(display.meter).toEqual({ beats: 4, beatValue: 4 });
          const key = a.presentation.key as unknown as Key;
          expect(keyFamily(key)).toBe(params.fam);
          expect(a.presentation.prog).toEqual(params.prog);
          expect(a.presentation.tempoBpm).toBe(LH_TEMPO_BPM);
          expect(a.stimulus.events.every((e) => e.role === "count-in")).toBe(true);
          expect(a.stimulus.events).toHaveLength(4);
          expect(a.expected.responseWindowMs).toBe(lhResponseWindowMs(8, LH_TEMPO_BPM));
          checkTarget(a, key);
        },
      ),
      { numRuns: 150 },
    );
  });

  function checkTarget(a: ItemInstance, key: Key): void {
    const play = a.expected.play;
    const written = a.display?.staves[0]?.measures.map((m) =>
      m.map((el) => (el.kind === "note" ? el.pitches.map(spelledToMidi) : [])),
    );
    expect(written).toHaveLength(2);
    if (play?.kind === "chordLine") {
      expect(a.nodeId).toBe(INV.id);
      expect(written?.flat()).toEqual(play.chords.map((c) => c.midi));
      expect(a.presentation.chords).toEqual(play.chords.map((c) => c.midi));
      expect(a.presentation.symbols).toEqual(play.chords.map((c) => c.symbol));
      expect(a.presentation.inversions).toHaveLength(4);
      play.chords.forEach((c, i) => {
        expect(c.onsetBeats).toBe(i * 2);
        expect(c.midi.every(inRange)).toBe(true);
        expect(new Set(c.midi.map((m) => pc(m, key)))).toEqual(new Set(TRIAD[c.roman]));
        const prev = play.chords[i - 1];
        if (prev) {
          c.midi.forEach((m, v) => {
            expect(Math.abs(m - at(prev.midi, v))).toBeLessThanOrEqual(5);
          });
        }
      });
      const all = play.chords.flatMap((c) => c.midi);
      expect(a.inputRange?.low).toBeLessThan(Math.min(...all));
      expect(a.inputRange?.high).toBeGreaterThan(Math.max(...all));
    } else if (play?.kind === "line") {
      expect(a.nodeId).not.toBe(INV.id);
      // Display and expectation agree note for note, and each bar holds four beats.
      expect(written?.flat()).toEqual(play.midi.map((m) => [m]));
      expect(scoreNoteIds(a.display ?? { staves: [] })).toHaveLength(play.midi.length);
      for (const bar of a.display?.staves[0]?.measures ?? []) {
        const beats = bar.reduce(
          (s, el) => s + (4 / el.duration.value) * (el.duration.dots === 1 ? 1.5 : 1),
          0,
        );
        expect(beats).toBe(4);
      }
      expect(play.midi.every(inRange)).toBe(true);
      expect(play.tempoBpm).toBe(LH_TEMPO_BPM);
      const pattern = a.params.pattern as LinePattern;
      expect(a.presentation.pattern).toBe(pattern);
      expect(play.onsetsBeats.slice(0, PATTERN_ONSETS[pattern].length)).toEqual(
        PATTERN_ONSETS[pattern],
      );
      expect(a.inputRange?.low).toBeLessThan(Math.min(...play.midi));
      expect(a.inputRange?.high).toBeGreaterThan(Math.max(...play.midi));
    } else {
      throw new Error(`unexpected target ${String(play?.kind)}`);
    }
  }

  it("writes no accidentals: every note is in the key signature", () => {
    for (const [node, items] of cases) {
      for (const key of MAJOR_KEYS) {
        const params = items.find((p) => p.fam === keyFamily(key)) ?? at(items, 0);
        const inst = lhPatternVariants.generate(node, params, ctx(5, key));
        for (const el of inst.display?.staves[0]?.measures.flat() ?? []) {
          if (el.kind === "note") expect(el.accidental).toBeUndefined();
        }
      }
    }
  });
});
