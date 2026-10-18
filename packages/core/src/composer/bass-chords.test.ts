import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { SkillGraph, SkillNode } from "../graph/schema.js";
import { createRng } from "../random.js";
import { itemId } from "../items/ids.js";
import { GENERATORS } from "../items/registry.js";
import type { LearnerState } from "../state/types.js";
import { keyFamily } from "../theory/keys.js";
import { composeSession } from "./compose.js";
import { D135, NOW } from "./fixtures/learners.js";
import {
  LANDMARKS,
  READ_GRAPH,
  RHYTHM,
  STEPS,
  STUB_READ_GENERATORS,
  readLearner,
} from "./fixtures/read.js";
import type { PlannedItem, SessionPlan } from "./types.js";

/*
 * Bass chord reading (T5.10, R27): read.bass.chords is a READ node whose generator needs
 * polyphonic input, so the composer offers and introduces it only when the session's input is MIDI.
 */

const CHORDS = "read.bass.chords";
const DAY = 86_400_000;

const chordsNode: SkillNode = {
  id: CHORDS,
  strand: "READ",
  title: "Bass chords",
  prerequisites: [LANDMARKS],
  itemGenerators: ["bassChordRead"],
  params: { clef: "bass", qualities: ["major", "minor"], inversions: ["root", "first", "second"] },
  mastery: { minAccuracy: 0.9, maxMedianLatencyMs: 3000, windowAttempts: 20, distinctSessions: 2 },
  keyDependent: true,
  targetLatencyMs: 3000,
};

const GRAPH: SkillGraph = {
  ...READ_GRAPH,
  generators: READ_GRAPH.generators.map((g) =>
    g.id === "bassChordRead" ? { ...g, implemented: true } : g,
  ),
  nodes: [...READ_GRAPH.nodes, chordsNode],
};
const generators = { ...GENERATORS, ...STUB_READ_GENERATORS };

const compose = (
  state: LearnerState,
  o: { polyphonic?: boolean; mode?: "instrument" | "away"; seed?: number; budgetSec?: number } = {},
): SessionPlan =>
  composeSession({
    graph: GRAPH,
    now: NOW,
    tzOffsetMin: 0,
    seed: o.seed ?? 42,
    generators,
    state,
    mode: o.mode ?? "instrument",
    ...(o.polyphonic === undefined ? {} : { polyphonic: o.polyphonic }),
    ...(o.budgetSec === undefined ? {} : { budgetSec: o.budgetSec }),
  });

const allItems = (p: SessionPlan): PlannedItem[] => [
  ...p.blocks.ear,
  ...p.blocks.read,
  ...(p.blocks.apply ?? []),
];
const chordItems = (p: SessionPlan): PlannedItem[] =>
  allItems(p).filter((i) => i.nodeId === CHORDS);

/** Chord reading learning in family A, with the bass landmarks mastered. */
function learningChords(due = false): LearnerState {
  return readLearner({
    graph: GRAPH,
    nodes: {
      [D135]: "mastered",
      [LANDMARKS]: { state: "mastered", byFamily: { A: "mastered" } },
      [CHORDS]: { state: "learning", byFamily: { A: "learning" }, introducedAt: NOW - 3 * DAY },
    },
    cards: due
      ? [{ nodeId: CHORDS, params: { fam: "A", roman: "IV", inv: "first" }, dueInDays: -1 }]
      : [],
  });
}

/** Every other READ node is mastered, so a chord reading introduction is the one on offer. */
function chordsAvailable(): LearnerState {
  return readLearner({
    graph: GRAPH,
    nodes: {
      [D135]: { state: "learning", introducedAt: NOW - 6 * DAY },
      [LANDMARKS]: { state: "mastered", byFamily: { A: "mastered" } },
      [STEPS]: { state: "mastered", byFamily: { A: "mastered" } },
      [RHYTHM]: "mastered",
      [CHORDS]: "available",
    },
  });
}

describe("bass chord reading in the composer (MIDI only)", () => {
  it("offers new chord items in the Read block with MIDI input, in a key of the family", () => {
    const plan = compose(learningChords(), { polyphonic: true });
    const items = chordItems(plan);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(plan.blocks.read).toContainEqual(item);
      expect(item.generator).toBe("bassChordRead");
      expect(item.fam).toBe("A");
      expect(item.key?.mode).toBe("major");
      expect(item.key === undefined ? undefined : keyFamily(item.key)).toBe("A");
      expect(item.itemId).toBe(itemId(CHORDS, item.params));
      // The planned item generates a one-chord, tones-only line in the planned key.
      const inst = GENERATORS.bassChordRead?.generate(chordsNode, item.params, {
        rng: createRng(1),
        mode: "instrument",
        ...(item.key === undefined ? {} : { preferredKey: item.key }),
      });
      expect(inst?.presentation.tonic).toBe(item.key?.tonic);
      const play = inst?.expected.play;
      expect(play?.kind === "chordLine" && play.chords.length).toBe(1);
      expect(play?.kind === "chordLine" && play.gradeTiming).toBe(false);
    }
  });

  it("puts a due chord item in the plan with its stored params, only with MIDI input", () => {
    const params = { fam: "A", roman: "IV", inv: "first" };
    const withMidi = chordItems(compose(learningChords(true), { polyphonic: true }));
    expect(withMidi).toContainEqual(expect.objectContaining({ isNew: false, params }));
    expect(chordItems(compose(learningChords(true)))).toEqual([]);
  });

  it("introduces the node only with MIDI input", () => {
    const withMidi = compose(chordsAvailable(), { polyphonic: true });
    expect(withMidi.introductions).toContain(CHORDS);
    expect(chordItems(withMidi).length).toBeGreaterThan(0);

    const without = compose(chordsAvailable());
    expect(without.introductions).not.toContain(CHORDS);
    expect(chordItems(without)).toEqual([]);
  });

  it("never offers chord reading without MIDI or in Away mode, whatever the seed or budget", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 120, max: 1800 }),
        (seed, budgetSec) => {
          for (const state of [learningChords(true), chordsAvailable()]) {
            for (const plan of [
              compose(state, { seed, budgetSec }),
              compose(state, { seed, budgetSec, polyphonic: false }),
              compose(state, { seed, budgetSec, polyphonic: true, mode: "away" }),
            ]) {
              expect(chordItems(plan)).toEqual([]);
              expect(plan.introductions).not.toContain(CHORDS);
            }
          }
        },
      ),
      { numRuns: 40 },
    );
  });
});
