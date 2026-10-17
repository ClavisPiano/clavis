import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { SkillNode } from "../graph/schema.js";
import { createRng } from "../random.js";
import { scoreNoteIds, ScoreSpecSchema, spelledToMidi } from "../score/schema.js";
import { StimulusSpecSchema } from "../stimulus/types.js";
import { degreeToMidi } from "../theory/degrees.js";
import { ALL_KEYS, type Key, type VoiceRange } from "../theory/keys.js";
import { at } from "../theory/util.js";
import {
  BYEAR_BARS,
  BYEAR_SLOTS_PER_LENGTH,
  byEarPhrase,
  melodyFor,
  melodyIsValid,
} from "./by-ear-phrase.js";
import { ExpectedResponseSchema } from "./expected.js";
import { itemId } from "./ids.js";
import { lineNotes } from "./piece-line.js";
import type { GenerateContext } from "./types.js";

const NODE: SkillNode = {
  id: "byear.melody.simple",
  strand: "BYEAR",
  title: "Play a heard melody",
  prerequisites: ["ear.cells.major.2-4"],
  itemGenerators: ["byEarPhrase"],
  params: { bars: [4, 8], diatonic: true, stages: ["melody"] },
  mastery: { minAccuracy: 0.8, windowAttempts: 5, distinctSessions: 2 },
  keyDependent: false,
};
const VOICE: VoiceRange = { low: 48, high: 72 };
const ctx = (seed: number, extra: Partial<GenerateContext> = {}): GenerateContext => ({
  rng: createRng(seed),
  voiceRange: VOICE,
  mode: "instrument",
  ...extra,
});
const MAJOR_KEYS = ALL_KEYS.filter((k) => k.mode === "major");
const items = byEarPhrase.listItems(NODE);

describe("byEarPhrase universe", () => {
  it("is one item per length and slot, shortest first", () => {
    expect(items).toHaveLength(BYEAR_BARS.length * BYEAR_SLOTS_PER_LENGTH);
    expect(items[0]).toEqual({ bars: 4, slot: 1 });
    expect(items.at(-1)).toEqual({ bars: 8, slot: BYEAR_SLOTS_PER_LENGTH });
    expect(new Set(items.map((p) => itemId(NODE.id, p))).size).toBe(items.length);
  });

  it("follows the node's bar range", () => {
    const short = { ...NODE, params: { ...NODE.params, bars: [4, 4] } };
    expect(byEarPhrase.listItems(short).every((p) => p.bars === 4)).toBe(true);
    expect(byEarPhrase.listItems(short)).toHaveLength(BYEAR_SLOTS_PER_LENGTH);
  });

  it("ids exclude the key and the generator (R1, R14)", () => {
    expect(itemId(NODE.id, at(items, 0))).toBe("byear.melody.simple|bars=4|slot=1");
  });

  it("rejects an item outside the universe", () => {
    expect(() => byEarPhrase.generate(NODE, { bars: 5, slot: 1 }, ctx(1))).toThrow(RangeError);
    expect(() => byEarPhrase.generate(NODE, { bars: 4, slot: 99 }, ctx(1))).toThrow();
  });
});

describe("melodyFor", () => {
  it("is deterministic", () => {
    for (const p of items) {
      expect(melodyFor(Number(p.bars), Number(p.slot))).toEqual(
        melodyFor(Number(p.bars), Number(p.slot)),
      );
    }
  });

  it("gives every slot its own melody", () => {
    for (const bars of BYEAR_BARS) {
      const seen = new Set<string>();
      for (let slot = 1; slot <= BYEAR_SLOTS_PER_LENGTH; slot++) {
        seen.add(JSON.stringify(melodyFor(bars, slot)));
      }
      expect(seen.size).toBe(BYEAR_SLOTS_PER_LENGTH);
    }
  });

  it.each(items.map((p) => [Number(p.bars), Number(p.slot)] as const))(
    "%i bars slot %i meets the melody rules",
    (bars, slot) => {
      const m = melodyFor(bars, slot);
      expect(melodyIsValid(m, bars)).toBe(true);
      // Starts on a stable degree, ends on the tonic.
      expect([1, 3, 5]).toContain(m.degrees[0]);
      expect([1, 8]).toContain(m.degrees.at(-1));
      // Diatonic, within an octave, no repeated neighbours, mostly stepwise.
      expect(m.degrees.every(Number.isInteger)).toBe(true);
      expect(Math.max(...m.degrees) - Math.min(...m.degrees)).toBeLessThanOrEqual(7);
      let steps = 0;
      m.degrees.forEach((d, i) => {
        if (i === 0) return;
        const move = Math.abs(d - at(m.degrees, i - 1));
        expect(move).toBeGreaterThan(0);
        expect(move).toBeLessThanOrEqual(4);
        if (move === 1) steps++;
      });
      expect(steps / (m.degrees.length - 1)).toBeGreaterThanOrEqual(0.6);
      // The rhythm fills whole bars of quarters, eighths and halves (and a closing whole note).
      expect(m.beats.reduce((a, b) => a + b, 0)).toBe(bars * 4);
      expect(m.beats.every((b) => [0.5, 1, 2, 4].includes(b))).toBe(true);
      expect(m.beats.length).toBe(m.degrees.length);
    },
  );

  it("finds a melody for any length and slot it is asked for", () => {
    fc.assert(
      fc.property(fc.constantFrom(...BYEAR_BARS), fc.integer({ min: 1, max: 40 }), (bars, slot) => {
        expect(melodyIsValid(melodyFor(bars, slot), bars)).toBe(true);
      }),
      { numRuns: 60 },
    );
  });
});

describe("byEarPhrase.generate", () => {
  const first = at(items, 0);

  it("is deterministic for a seed", () => {
    for (const p of items) {
      expect(byEarPhrase.generate(NODE, p, ctx(5))).toEqual(byEarPhrase.generate(NODE, p, ctx(5)));
    }
  });

  it("keeps the same id and the same melody (in degrees) in every key", () => {
    const base = byEarPhrase.generate(NODE, first, ctx(1, { preferredKey: at(MAJOR_KEYS, 0) }));
    for (const key of MAJOR_KEYS) {
      const inst = byEarPhrase.generate(NODE, first, ctx(2, { preferredKey: key }));
      expect(inst.itemId).toBe(base.itemId);
      expect(inst.presentation.degrees).toEqual(base.presentation.degrees);
      expect(inst.presentation.tonic).toBe(key.tonic);
    }
  });

  it("uses the key of the day when major, a major key otherwise (R1)", () => {
    const day: Key = { tonic: "D", mode: "major" };
    const inst = byEarPhrase.generate(NODE, first, ctx(1, { preferredKey: day }));
    expect(inst.presentation.tonic).toBe("D");
    for (let seed = 0; seed < 20; seed++) {
      const minorDay: Key = { tonic: "A", mode: "minor" };
      const other = byEarPhrase.generate(NODE, first, ctx(seed, { preferredKey: minorDay }));
      expect(other.presentation.mode).toBe("major");
    }
  });

  it("plays diatonic notes in the key, in the voice range, after the cadence", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...items),
        fc.constantFrom(...MAJOR_KEYS),
        fc.integer({ min: 0, max: 1000 }),
        (p, key, seed) => {
          const inst = byEarPhrase.generate(NODE, p, ctx(seed, { preferredKey: key }));
          const tonicMidi = Number(inst.presentation.tonicMidi);
          const degrees = inst.presentation.degrees as number[];
          const midi = inst.presentation.targetMidi as number[];
          expect(midi).toEqual(degrees.map((d) => degreeToMidi(key, d, tonicMidi)));
          for (const m of midi) {
            expect(m).toBeGreaterThanOrEqual(VOICE.low);
            expect(m).toBeLessThanOrEqual(VOICE.high);
          }
          const cadence = inst.stimulus.events.filter((e) => e.role === "cadence");
          const targets = inst.stimulus.events.filter((e) => e.role === "target");
          expect(cadence.length).toBeGreaterThan(0);
          expect(targets.map((e) => at(e.midi, 0))).toEqual(midi);
          const lastCadenceEnd = Math.max(...cadence.map((e) => e.atSec + e.durationSec));
          expect(Math.min(...targets.map((e) => e.atSec))).toBeGreaterThanOrEqual(lastCadenceEnd);
        },
      ),
      { numRuns: 120 },
    );
  });

  it("carries the full melody in the presentation (R2) and parses", () => {
    const inst = byEarPhrase.generate(NODE, at(items, 7), ctx(3));
    expect(inst.generator).toBe("byEarPhrase");
    expect(inst.params).toEqual(at(items, 7));
    for (const k of ["degrees", "beats", "targetMidi", "onsetsBeats", "tonicMidi", "seed"]) {
      expect(inst.presentation).toHaveProperty(k);
    }
    expect(StimulusSpecSchema.safeParse(inst.stimulus).success).toBe(true);
    expect(ExpectedResponseSchema.safeParse(inst.expected).success).toBe(true);
    expect(inst.display).toBeUndefined();
  });

  it("expects a sung sequence, then the same line played (R12)", () => {
    const inst = byEarPhrase.generate(NODE, first, ctx(1));
    const { sing, play } = inst.expected;
    if (sing?.kind !== "sungSequence" || play?.kind !== "line") throw new Error("shape");
    expect(sing.midi).toEqual(play.midi);
    expect(play.midi).toEqual(inst.presentation.targetMidi);
    expect(play.onsetsBeats[0]).toBe(0);
    expect(play.beatsPerBar).toBe(4);
  });

  it("reveals the melody as a score in the key that matches what sounded", () => {
    fc.assert(
      fc.property(fc.constantFrom(...items), fc.constantFrom(...MAJOR_KEYS), (p, key) => {
        const inst = byEarPhrase.generate(NODE, p, ctx(9, { preferredKey: key }));
        const reveal = inst.reveal;
        if (reveal === undefined) throw new Error("no reveal");
        expect(ScoreSpecSchema.safeParse(reveal).success).toBe(true);
        expect(reveal.key).toEqual({ tonic: key.tonic, mode: "major" });
        expect(reveal.staves[0]?.measures).toHaveLength(Number(p.bars));
        const notes = lineNotes(reveal);
        expect(notes.map((n) => n.midi)).toEqual(inst.presentation.targetMidi);
        expect(notes.map((n) => n.onsetBeats)).toEqual(inst.presentation.onsetsBeats);
        expect(scoreNoteIds(reveal)).toHaveLength(notes.length);
        const spelled = (reveal.staves[0]?.measures ?? [])
          .flat()
          .flatMap((e) => (e.kind === "note" ? e.pitches : []));
        expect(spelled.map(spelledToMidi)).toEqual(inst.presentation.targetMidi);
      }),
      { numRuns: 80 },
    );
  });

  it("gives the keyboard room around the melody", () => {
    const inst = byEarPhrase.generate(NODE, first, ctx(1));
    const midi = inst.presentation.targetMidi as number[];
    expect(inst.inputRange?.low).toBeLessThan(Math.min(...midi));
    expect(inst.inputRange?.high).toBeGreaterThan(Math.max(...midi));
  });
});
