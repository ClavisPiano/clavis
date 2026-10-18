import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { SkillNode } from "../graph/schema.js";
import { createRng } from "../random.js";
import { ScoreSpecSchema, scoreNoteIds, spelledToMidi } from "../score/schema.js";
import { StimulusSpecSchema } from "../stimulus/types.js";
import { ALL_KEYS, keyFamily, tonicChroma, type Key } from "../theory/keys.js";
import { at } from "../theory/util.js";
import { enumerateBassMotions } from "./bass-motion.js";
import { COORD_MELODIES, RH_RANGE, chordDegrees, coordMelody, coordTask } from "./coord-task.js";
import { ExpectedResponseSchema } from "./expected.js";
import { itemId } from "./ids.js";
import { LH_RANGE, LH_TEMPO_BPM, lhResponseWindowMs } from "./lh-pattern.js";
import { getGenerator } from "./registry.js";
import type { GenerateContext, ItemParams } from "./types.js";

const NODE_ID = "hands.coord.basic";
const node: SkillNode = {
  id: NODE_ID,
  strand: "HANDS",
  title: "Hands together, block chords",
  prerequisites: ["hands.lh.triads.root"],
  itemGenerators: ["coordTask"],
  params: { rh: "melody", lh: "block", chords: ["I", "IV", "V", "vi"] },
  mastery: { minAccuracy: 0.8, windowAttempts: 5, distinctSessions: 2 },
  keyDependent: true,
};

const MAJOR_KEYS = ALL_KEYS.filter((k) => k.mode === "major");
const PROGS = enumerateBassMotions(["I", "IV", "V", "vi"]);
const ctx = (seed: number, preferredKey?: Key): GenerateContext => ({
  rng: createRng(seed),
  mode: "instrument",
  ...(preferredKey === undefined ? {} : { preferredKey }),
});

/** Semitones above the tonic of each scale degree (0 = tonic) of a major key. */
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
/** Pitch classes, relative to the tonic, of each numeral's triad. */
const CHORD_PCS: Record<string, number[]> = {
  I: [0, 4, 7],
  IV: [5, 9, 0],
  V: [7, 11, 2],
  vi: [9, 0, 4],
};
const rel = (midi: number, key: Key): number => (((midi - tonicChroma(key)) % 12) + 12) % 12;

describe("coordTask universe", () => {
  it("is the bass motion progressions times three melodies in each key family", () => {
    const items = coordTask.listItems(node);
    expect(PROGS).toHaveLength(27);
    expect(items).toHaveLength(3 * 27 * COORD_MELODIES);
    expect(items).toHaveLength(243);
    expect(items[0]).toEqual({ fam: "A", prog: ["I", "IV", "I", "IV"], mel: 1 });
    expect(coordTask.listItems(node)).toEqual(items);
    const ids = items.map((p) => itemId(NODE_ID, p));
    expect(new Set(ids).size).toBe(items.length);
    expect(ids[0]).toBe(`${NODE_ID}|fam=A|mel=1|prog=I-IV-I-IV`);
  });

  it("is registered and rejects other nodes and stray chords", () => {
    expect(getGenerator("coordTask")).toBe(coordTask);
    expect(() =>
      coordTask.listItems({ ...node, params: { rh: "melody", lh: ["broken", "pop"] } }),
    ).toThrow();
    expect(() =>
      coordTask.generate(node, { fam: "A", prog: ["I", "ii", "V", "I"], mel: 1 }, ctx(1)),
    ).toThrow(/not in node/);
    expect(() =>
      coordTask.generate(node, { fam: "A", prog: ["I", "IV", "V", "I"], mel: 4 }, ctx(1)),
    ).toThrow();
  });
});

describe("coordMelody", () => {
  it("is a pure function of the progression and melody number", () => {
    for (const prog of PROGS) {
      for (let mel = 1; mel <= COORD_MELODIES; mel++) {
        expect(coordMelody(prog, mel)).toEqual(coordMelody([...prog], mel));
      }
    }
  });

  it("gives each progression three different melodies", () => {
    for (const prog of PROGS) {
      const mels = [1, 2, 3].map((m) => coordMelody(prog, m).join(","));
      expect(new Set(mels).size).toBe(3);
    }
  });

  it("fits each chord: a chord tone on beats 1 and 3, sixteen quarters in a five-finger position", () => {
    for (const prog of PROGS) {
      for (let mel = 1; mel <= COORD_MELODIES; mel++) {
        const m = coordMelody(prog, mel);
        expect(m).toHaveLength(16);
        for (const d of m) {
          expect(d).toBeGreaterThanOrEqual(0);
          expect(d).toBeLessThanOrEqual(4);
        }
        prog.forEach((roman, bar) => {
          expect(chordDegrees(roman)).toContain(at(m, bar * 4));
          expect(chordDegrees(roman)).toContain(at(m, bar * 4 + 2));
        });
        // It starts on a tone of I and ends on a tone of the last chord.
        expect(chordDegrees("I")).toContain(at(m, 0));
        expect(chordDegrees(at(prog, 3))).toContain(at(m, 15));
      }
    }
  });

  it("is mostly stepwise: no leap wider than a third, and at most one third", () => {
    for (const prog of PROGS) {
      for (let mel = 1; mel <= COORD_MELODIES; mel++) {
        const m = coordMelody(prog, mel);
        const moves = m.slice(1).map((d, i) => Math.abs(d - at(m, i)));
        expect(Math.max(...moves)).toBeLessThanOrEqual(2);
        expect(moves.filter((x) => x === 2).length).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("coordTask generate", () => {
  const items = coordTask.listItems(node);

  it("has an id that is stable across keys, with the family but not the key", () => {
    const params: ItemParams = { fam: "B", prog: ["I", "IV", "V", "I"], mel: 2 };
    const keys = MAJOR_KEYS.filter((k) => keyFamily(k) === "B");
    expect(keys.length).toBeGreaterThan(1);
    const insts = keys.map((key) => coordTask.generate(node, params, ctx(3, key)));
    expect(new Set(insts.map((i) => i.itemId))).toEqual(
      new Set([`${NODE_ID}|fam=B|mel=2|prog=I-IV-V-I`]),
    );
    // The same tune in every key: the melody's degrees do not depend on the key.
    const degrees = insts.map((inst) => {
      const key = inst.presentation.key as unknown as Key;
      const melody = inst.presentation.melody as number[];
      return melody.map((m) => MAJOR_SCALE.indexOf(rel(m, key))).join(",");
    });
    expect(new Set(degrees).size).toBe(1);
  });

  it("is a valid grand-staff performance for any item in any key", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: items.length - 1 }),
        fc.integer({ min: 0, max: 1000 }),
        fc.constantFrom(...MAJOR_KEYS),
        (idx, seed, preferred) => {
          const params = at(items, idx);
          const a = coordTask.generate(node, params, ctx(seed, preferred));
          expect(coordTask.generate(node, params, ctx(seed, preferred))).toEqual(a);
          expect(a.itemId).toBe(itemId(NODE_ID, params));
          expect(a.generator).toBe("coordTask");
          ExpectedResponseSchema.parse(a.expected);
          StimulusSpecSchema.parse(a.stimulus);
          const display = ScoreSpecSchema.parse(a.display);
          const play = a.expected.play;
          if (play?.kind !== "performance") throw new Error("expected a performance");
          const key = a.presentation.key as unknown as Key;
          expect(keyFamily(key)).toBe(params.fam);
          const prog = params.prog as string[];

          // Grand staff: four bars of 4/4, quarters over whole-note chords, ids n1..n20.
          expect(display.staves.map((s) => s.clef)).toEqual(["treble", "bass"]);
          expect(display.meter).toEqual({ beats: 4, beatValue: 4 });
          expect(scoreNoteIds(display)).toEqual(
            Array.from({ length: 20 }, (_, i) => `n${String(i + 1)}`),
          );
          const [treble, bass] = display.staves;
          for (const bar of treble?.measures ?? []) {
            expect(bar.map((el) => el.duration.value)).toEqual([4, 4, 4, 4]);
          }
          for (const bar of bass?.measures ?? []) {
            expect(bar.map((el) => el.duration.value)).toEqual([1]);
          }
          for (const el of [...(treble?.measures ?? []), ...(bass?.measures ?? [])].flat()) {
            if (el.kind === "note") expect(el.accidental).toBeUndefined();
          }

          // The target is the score: every written pitch, at its beat, with its hand.
          const rh = play.notes.filter((n) => n.hand === "rh");
          const lh = play.notes.filter((n) => n.hand === "lh");
          expect(rh.map((n) => n.midi)).toEqual(
            treble?.measures
              .flat()
              .map((el) => (el.kind === "note" ? spelledToMidi(at(el.pitches, 0)) : 0)),
          );
          expect(rh.map((n) => n.onsetBeats)).toEqual(Array.from({ length: 16 }, (_, i) => i));
          expect(lh).toHaveLength(12);
          expect(play.tempoBpm).toBe(LH_TEMPO_BPM);
          expect(play.beatsPerBar).toBe(4);
          const onsets = play.notes.map((n) => n.onsetBeats);
          expect([...onsets].sort((x, y) => x - y)).toEqual(onsets);

          prog.forEach((roman, bar) => {
            // LH: the bar's root-position triad, held for the bar, in C2 to C4.
            const chord = lh.filter((n) => n.onsetBeats === bar * 4);
            expect(chord.map((n) => rel(n.midi, key))).toEqual(CHORD_PCS[roman]);
            for (const n of chord) {
              expect(n.durationBeats).toBe(4);
              expect(n.midi).toBeGreaterThanOrEqual(LH_RANGE.low);
              expect(n.midi).toBeLessThanOrEqual(LH_RANGE.high);
            }
            // RH: chord tones on beats 1 and 3, every note in the key.
            for (const beat of [0, 2]) {
              expect(CHORD_PCS[roman]).toContain(rel(at(rh, bar * 4 + beat).midi, key));
            }
          });
          for (const n of rh) {
            expect(MAJOR_SCALE).toContain(rel(n.midi, key));
            expect(n.midi).toBeGreaterThanOrEqual(RH_RANGE.low);
            expect(n.midi).toBeLessThanOrEqual(RH_RANGE.high);
          }
          // The hands never share a key: the melody sits above the chords.
          expect(Math.min(...rh.map((n) => n.midi))).toBeGreaterThan(
            Math.max(...lh.map((n) => n.midi)),
          );

          // Replay and view data (R2): chords, symbols, melody, a count-in only.
          expect(a.presentation.prog).toEqual(prog);
          expect(a.presentation.mel).toBe(params.mel);
          expect(a.presentation.symbols).toHaveLength(4);
          expect(a.presentation.melody).toEqual(rh.map((n) => n.midi));
          expect(a.stimulus.events).toHaveLength(4);
          expect(a.stimulus.events.every((e) => e.role === "count-in")).toBe(true);
          expect(a.expected.responseWindowMs).toBe(lhResponseWindowMs(16, LH_TEMPO_BPM));
          const all = play.notes.map((n) => n.midi);
          expect(a.inputRange?.low).toBeLessThan(Math.min(...all));
          expect(a.inputRange?.high).toBeGreaterThan(Math.max(...all));
        },
      ),
      { numRuns: 200 },
    );
  });

  it("keeps the right hand above a left hand that reaches middle C", () => {
    // In C major the IV chord after I is F3 A3 C4, so the melody moves up to C5.
    const inst = coordTask.generate(
      node,
      { fam: "A", prog: ["I", "IV", "V", "I"], mel: 1 },
      ctx(1, { tonic: "C", mode: "major" }),
    );
    const play = inst.expected.play;
    if (play?.kind !== "performance") throw new Error("expected a performance");
    expect(Math.max(...play.notes.filter((n) => n.hand === "lh").map((n) => n.midi))).toBe(60);
    expect(
      Math.min(...play.notes.filter((n) => n.hand === "rh").map((n) => n.midi)),
    ).toBeGreaterThanOrEqual(72);
  });
});
