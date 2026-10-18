import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { SkillNode } from "../graph/schema.js";
import { createRng } from "../random.js";
import {
  ScoreSpecSchema,
  scoreNoteIds,
  spelledToMidi,
  type ScoreNote,
  type ScoreSpec,
} from "../score/schema.js";
import { StimulusSpecSchema } from "../stimulus/types.js";
import { ALL_KEYS, keyFamily, tonicChroma, type Key } from "../theory/keys.js";
import { ExpectedResponseSchema } from "./expected.js";
import { itemId } from "./ids.js";
import { getGenerator } from "./registry.js";
import {
  SIGHT_LH_RANGE,
  SIGHT_LINE_SLOTS,
  SIGHT_LINE_TEMPO_BPM,
  SIGHT_RH_RANGE,
  sightLine,
  sightLineFor,
  sightLineScore,
  sightMelodyIsValid,
  type SightLineStyle,
} from "./sight-line.js";
import type { GenerateContext, ItemInstance, ItemParams } from "./types.js";

const base = {
  strand: "READ" as const,
  itemGenerators: ["sightLine" as const],
  mastery: { minAccuracy: 0.85, windowAttempts: 10, distinctSessions: 2 },
  keyDependent: true,
};
const TWO_LINE: SkillNode = {
  ...base,
  id: "read.grand.2line",
  title: "Two-staff lines",
  prerequisites: ["read.bass.intervals"],
  params: { staves: "grand", bars: [2, 4], style: "lines", keyOfDay: true },
};
const SIGHT: SkillNode = {
  ...base,
  id: "read.grand.sight",
  title: "Sight-reading",
  prerequisites: ["read.grand.2line", "hands.coord.basic"],
  params: { staves: "grand", bars: [4, 8], style: "sight", graded: true },
};
const NODES: readonly [SkillNode, SightLineStyle][] = [
  [TWO_LINE, "lines"],
  [SIGHT, "sight"],
];

const MAJOR_KEYS = ALL_KEYS.filter((k) => k.mode === "major");
const ctx = (seed: number, preferredKey?: Key): GenerateContext => ({
  rng: createRng(seed),
  mode: "instrument",
  ...(preferredKey === undefined ? {} : { preferredKey }),
});

/** Major-scale semitones above the tonic, for checking every note is diatonic. */
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const chroma = (midi: number, key: Key): number => (((midi - tonicChroma(key)) % 12) + 12) % 12;

const notesOf = (score: ScoreSpec, staff: number): ScoreNote[] =>
  (score.staves[staff]?.measures ?? []).flat().filter((e): e is ScoreNote => e.kind === "note");

describe("sightLine universe", () => {
  it("is families x lengths x slots, in a stable order with unique ids", () => {
    const two = sightLine.listItems(TWO_LINE);
    expect(two).toHaveLength(3 * 2 * SIGHT_LINE_SLOTS);
    expect(two[0]).toEqual({ fam: "A", bars: 2, slot: 1 });
    expect(new Set(two.map((p) => p.bars))).toEqual(new Set([2, 4]));
    const sight = sightLine.listItems(SIGHT);
    expect(sight).toHaveLength(3 * 3 * SIGHT_LINE_SLOTS);
    expect(new Set(sight.map((p) => p.bars))).toEqual(new Set([4, 6, 8]));
    for (const [node] of NODES) {
      const items = sightLine.listItems(node);
      expect(sightLine.listItems(node)).toEqual(items);
      expect(new Set(items.map((p) => itemId(node.id, p))).size).toBe(items.length);
    }
    expect(itemId(TWO_LINE.id, { fam: "A", bars: 2, slot: 1 })).toBe(
      "read.grand.2line|bars=2|fam=A|slot=1",
    );
  });

  it("is registered, and rejects a length the node does not offer", () => {
    expect(getGenerator("sightLine")).toBe(sightLine);
    expect(() => sightLine.generate(TWO_LINE, { fam: "A", bars: 8, slot: 1 }, ctx(1))).toThrow(
      /not offered/,
    );
    expect(() => sightLine.generate(SIGHT, { fam: "A", bars: 2, slot: 1 }, ctx(1))).toThrow(
      /not offered/,
    );
    expect(() => sightLine.listItems({ ...TWO_LINE, params: { bars: [2, 4] } })).toThrow();
  });
});

describe("sightLineFor", () => {
  it("is a pure function of style, length and slot", () => {
    for (const [, style] of NODES) {
      for (const bars of style === "lines" ? [2, 4] : [4, 6, 8]) {
        for (let slot = 1; slot <= SIGHT_LINE_SLOTS; slot++) {
          expect(sightLineFor(style, bars, slot)).toEqual(sightLineFor(style, bars, slot));
        }
      }
    }
  });

  it.each([
    ["lines", 2],
    ["lines", 4],
    ["sight", 4],
    ["sight", 6],
    ["sight", 8],
  ] as const)("%s, %i bars: every slot keeps the rules", (style, bars) => {
    const lines = Array.from({ length: SIGHT_LINE_SLOTS }, (_, i) =>
      sightLineFor(style, bars, i + 1),
    );
    // The slots are different lines.
    expect(new Set(lines.map((l) => JSON.stringify(l))).size).toBe(SIGHT_LINE_SLOTS);
    for (const line of lines) {
      expect(line.chords).toHaveLength(bars);
      expect(line.chords.at(-1)).toBe("I");
      if (bars > 2) {
        expect(line.chords[0]).toBe("I");
        expect(line.chords.at(-2)).toBe("V");
      }
      if (style === "lines") expect(line.chords).not.toContain("vi");
      for (const hand of [line.rh, line.lh]) {
        expect(hand).toHaveLength(bars);
        for (const bar of hand) expect(bar.reduce((s, n) => s + n.beats, 0)).toBe(4);
      }
      // Right hand: single notes. Left hand: single notes or a bare fifth.
      expect(line.rh.flat().every((n) => n.steps.length === 1)).toBe(true);
      for (const n of line.lh.flat()) expect([[0], [4], [0, 4]]).toContainEqual(n.steps);
      const rh = line.rh.flat().map((n) => n.steps[0] ?? 0);
      expect(sightMelodyIsValid(style, rh)).toBe(true);
      // `lines` uses quarters and longer and holds the left hand for the bar.
      if (style === "lines") {
        expect(line.rh.flat().every((n) => n.beats >= 1)).toBe(true);
        expect(line.lh.every((bar) => bar.length === 1)).toBe(true);
      }
    }
  });

  it("puts a chord tone on beats 1 and 3", () => {
    const ROOT: Record<string, number> = { I: 0, IV: 3, V: 4, vi: 5 };
    for (const [style, lengths] of [
      ["lines", [2, 4]],
      ["sight", [4, 6, 8]],
    ] as const) {
      for (const bars of lengths) {
        for (let slot = 1; slot <= SIGHT_LINE_SLOTS; slot++) {
          const line = sightLineFor(style, bars, slot);
          line.rh.forEach((bar, b) => {
            const root = ROOT[line.chords[b] ?? "I"] ?? 0;
            const tones = [root, root + 2, root + 4].map((s) => s % 7);
            let t = 0;
            for (const n of bar) {
              if (t === 0 || t === 2) {
                expect(tones).toContain((((n.steps[0] ?? 0) % 7) + 7) % 7);
              }
              t += n.beats;
            }
          });
        }
      }
    }
  });
});

describe("sightLine generate", () => {
  /** Every item of both nodes in every major key. */
  const cases: [SkillNode, ItemParams, Key][] = NODES.flatMap(([node]) =>
    sightLine
      .listItems(node)
      .filter((p) => p.fam === "A")
      .flatMap((p) => MAJOR_KEYS.map((k): [SkillNode, ItemParams, Key] => [node, p, k])),
  );

  const generateIn = (node: SkillNode, p: ItemParams, key: Key): ItemInstance =>
    sightLine.generate(node, { ...p, fam: keyFamily(key) }, ctx(7, key));

  it("plays in the key: the key of the day when it is in the item's family", () => {
    for (const [node, p, key] of cases) {
      const inst = generateIn(node, p, key);
      expect(inst.presentation.tonic).toBe(key.tonic);
      expect(inst.display?.key).toEqual({ tonic: key.tonic, mode: "major" });
      const play = inst.expected.play;
      if (play?.kind !== "performance") throw new Error("expected a performance");
      // Every note is in the major scale of the key, so no accidental is written.
      for (const n of play.notes) expect(MAJOR_SCALE).toContain(chroma(n.midi, key));
      for (const staff of [0, 1]) {
        for (const n of notesOf(must(inst.display), staff)) {
          expect(n.accidental).toBeUndefined();
        }
      }
    }
  });

  it("keeps each hand in its range and on its staff", () => {
    for (const [node, p, key] of cases) {
      const inst = generateIn(node, p, key);
      const play = inst.expected.play;
      if (play?.kind !== "performance") throw new Error("expected a performance");
      for (const n of play.notes) {
        const range = n.hand === "rh" ? SIGHT_RH_RANGE : SIGHT_LH_RANGE;
        expect(n.midi).toBeGreaterThanOrEqual(range.low);
        expect(n.midi).toBeLessThanOrEqual(range.high);
      }
      const all = play.notes.map((n) => n.midi);
      expect(inst.inputRange?.low).toBeLessThanOrEqual(Math.min(...all));
      expect(inst.inputRange?.high).toBeGreaterThanOrEqual(Math.max(...all));
      // The two hands never cross.
      const rh = play.notes.filter((n) => n.hand === "rh").map((n) => n.midi);
      const lh = play.notes.filter((n) => n.hand === "lh").map((n) => n.midi);
      expect(Math.max(...lh)).toBeLessThan(Math.min(...rh));
    }
  });

  it("draws a valid grand staff whose notes are the performance target", () => {
    for (const [node, p, key] of cases) {
      const inst = generateIn(node, p, key);
      const score = ScoreSpecSchema.parse(inst.display);
      expect(score.staves.map((s) => s.clef)).toEqual(["treble", "bass"]);
      expect(score.staves[0]?.measures).toHaveLength(Number(p.bars));
      expect(ExpectedResponseSchema.safeParse(inst.expected).success).toBe(true);
      expect(StimulusSpecSchema.safeParse(inst.stimulus).success).toBe(true);
      const play = inst.expected.play;
      if (play?.kind !== "performance") throw new Error("expected a performance");
      expect(play.tempoBpm).toBe(SIGHT_LINE_TEMPO_BPM);
      expect(play.beatsPerBar).toBe(4);
      // Each target note names a score note (a fifth's tones `n9.0`, `n9.1`) with its pitch.
      const ids = scoreNoteIds(score);
      const byId = new Map(
        score.staves.flatMap((s, staff) =>
          notesOf(score, staff).map((n) => [n.id, { n, hand: staff === 0 ? "rh" : "lh" }]),
        ),
      );
      for (const t of play.notes) {
        const [base, tone] = t.id.split(".");
        expect(ids).toContain(base);
        const entry = byId.get(base ?? "");
        expect(entry?.hand).toBe(t.hand);
        const pitch = entry?.n.pitches[tone === undefined ? 0 : Number(tone)];
        expect(pitch && spelledToMidi(pitch)).toBe(t.midi);
      }
      const count = [0, 1].reduce(
        (s, staff) => s + notesOf(score, staff).reduce((k, n) => k + n.pitches.length, 0),
        0,
      );
      expect(play.notes).toHaveLength(count);
      // Onset order, the line ends with both hands on the tonic.
      const onsets = play.notes.map((n) => n.onsetBeats);
      expect([...onsets].sort((a, b) => a - b)).toEqual(onsets);
      const lastRh = play.notes.filter((n) => n.hand === "rh").at(-1);
      expect(chroma(lastRh?.midi ?? 0, key)).toBe(0);
      const lastLh = play.notes.filter((n) => n.hand === "lh").at(-1);
      expect([0, 7]).toContain(chroma(lastLh?.midi ?? 0, key));
    }
  });

  it("has an id that is pure in its params: the same line, moved, in every key of the family", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...NODES.map(([n]) => n)),
        fc.nat(),
        fc.nat(),
        (node, pick, seed) => {
          const items = sightLine.listItems(node);
          const p = must(items[pick % items.length]);
          const keys = MAJOR_KEYS.filter((k) => keyFamily(k) === p.fam);
          const insts = keys.map((k) => sightLine.generate(node, p, ctx(seed, k)));
          expect(new Set(insts.map((i) => i.itemId))).toEqual(new Set([itemId(node.id, p)]));
          expect(insts.every((i) => JSON.stringify(i.params) === JSON.stringify(p))).toBe(true);
          // The rhythm and the chords do not depend on the key.
          const shape = (i: ItemInstance): unknown => {
            const play = i.expected.play;
            if (play?.kind !== "performance") throw new Error("expected a performance");
            return [i.presentation.chords, play.notes.map((n) => [n.id, n.onsetBeats, n.hand])];
          };
          for (const i of insts) expect(shape(i)).toEqual(shape(must(insts[0])));
          // The family is the item's, whatever the preferred key.
          const other = sightLine.generate(node, p, ctx(seed));
          const tonic = other.presentation.tonic;
          if (typeof tonic !== "string") throw new Error("no tonic");
          expect(keyFamily({ tonic, mode: "major" })).toBe(p.fam);
        },
      ),
      { numRuns: 60 },
    );
  });

  it("counts in for a bar at 60 bpm and allows the line twice over to answer", () => {
    const inst = sightLine.generate(SIGHT, { fam: "A", bars: 8, slot: 3 }, ctx(1));
    expect(inst.stimulus.events.map((e) => e.role)).toEqual(Array(4).fill("count-in"));
    expect(inst.stimulus.events.map((e) => e.atSec)).toEqual([0, 1, 2, 3]);
    expect(inst.expected.responseWindowMs).toBe(32 * 1000 * 2 + 8000);
    expect(
      sightLine.generate(TWO_LINE, { fam: "A", bars: 2, slot: 1 }, ctx(1)).expected
        .responseWindowMs,
    ).toBe(24000);
  });

  it("writes C major line A, slot 1 as a fixed golden", () => {
    const inst = sightLine.generate(
      TWO_LINE,
      { fam: "A", bars: 2, slot: 1 },
      ctx(1, { tonic: "C", mode: "major" }),
    );
    expect(inst.itemId).toBe("read.grand.2line|bars=2|fam=A|slot=1");
    expect({
      chords: inst.presentation.chords,
      rh: inst.presentation.rhMidi,
      lh: inst.presentation.lhMidi,
    }).toMatchInlineSnapshot(`
      {
        "chords": [
          "I",
          "I",
        ],
        "lh": [
          48,
          48,
        ],
        "rh": [
          72,
          76,
          74,
          72,
        ],
      }
    `);
  });
});

describe("sightLineScore", () => {
  it("refuses a minor key", () => {
    expect(() =>
      sightLineScore(sightLineFor("lines", 2, 1), { tonic: "A", mode: "minor" }),
    ).toThrow(RangeError);
  });
});

function must<T>(x: T | undefined): T {
  if (x === undefined) throw new Error("missing");
  return x;
}
