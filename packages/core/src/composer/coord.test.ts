import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { SkillGraph, SkillNode } from "../graph/schema.js";
import { itemId } from "../items/ids.js";
import { GENERATORS } from "../items/registry.js";
import type { LearnerState } from "../state/types.js";
import { composeSession, HANDS_NEW_ITEMS_PER_SESSION } from "./compose.js";
import { D135, NOW } from "./fixtures/learners.js";
import { READ_GRAPH, STUB_READ_GENERATORS, readLearner } from "./fixtures/read.js";
import type { PlannedItem, SessionPlan } from "./types.js";

/*
 * Hands together (T5.5): `coordTask` items of hands.coord.basic join the Apply block like the
 * left-hand chords, with MIDI input only, and never in Away or practice.
 */

const LH = "hands.lh.triads.root";
const COORD = "hands.coord.basic";
const DAY = 86_400_000;

function coordGraph(): SkillGraph {
  const lh = READ_GRAPH.nodes.find((n) => n.id === LH);
  if (!lh) throw new Error("fixture graph lacks the chord node");
  const coord: SkillNode = {
    ...lh,
    id: COORD,
    title: "Hands together, block chords",
    prerequisites: [LH],
    itemGenerators: ["coordTask"],
    params: { rh: "melody", lh: "block", chords: ["I", "IV", "V", "vi"] },
  };
  return {
    ...READ_GRAPH,
    generators: READ_GRAPH.generators.map((g) =>
      g.id === "coordTask" ? { ...g, implemented: true, seedDurationSec: 45 } : g,
    ),
    nodes: [...READ_GRAPH.nodes, coord],
  };
}

const GRAPH = coordGraph();
const generators = { ...GENERATORS, ...STUB_READ_GENERATORS };

const compose = (
  state: LearnerState,
  o: { polyphonic?: boolean; mode?: "instrument" | "away"; practice?: boolean; seed?: number } = {},
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
    ...(o.practice ? { practice: true } : {}),
  });

const allItems = (p: SessionPlan): PlannedItem[] => [
  ...p.blocks.ear,
  ...p.blocks.read,
  ...(p.blocks.apply ?? []),
];
const coordItems = (p: SessionPlan): PlannedItem[] => allItems(p).filter((i) => i.nodeId === COORD);

/** Chords mastered, hands together learning, optionally with a card due. */
function learningCoord(
  cards: { fam: "A"; prog: string[]; mel: number; dueInDays: number }[] = [],
): LearnerState {
  return readLearner({
    graph: GRAPH,
    nodes: {
      [D135]: "mastered",
      [LH]: { state: "mastered", byFamily: { A: "mastered" }, introducedAt: NOW - 30 * DAY },
      [COORD]: { state: "learning", byFamily: { A: "learning" }, introducedAt: NOW - 2 * DAY },
    },
    cards: cards.map(({ dueInDays, ...params }) => ({ nodeId: COORD, params, dueInDays })),
  });
}

describe("coordTask in the composer", () => {
  it("offers new hands-together items in the Apply block with MIDI input", () => {
    const plan = compose(learningCoord(), { polyphonic: true });
    const items = coordItems(plan);
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThanOrEqual(HANDS_NEW_ITEMS_PER_SESSION);
    for (const item of items) {
      expect(plan.blocks.apply).toContainEqual(item);
      expect(item.generator).toBe("coordTask");
      expect(item.isNew).toBe(true);
      expect(item.fam).toBe("A");
      expect(item.itemId).toBe(itemId(COORD, item.params));
      expect(item.itemId).toMatch(
        /^hands\.coord\.basic\|fam=A\|mel=[123]\|prog=I(-(I|IV|V|vi)){3}$/,
      );
    }
  });

  it("puts a due hands-together item first", () => {
    const params = { fam: "A" as const, prog: ["I", "V", "vi", "IV"], mel: 2 };
    const plan = compose(learningCoord([{ ...params, dueInDays: -1 }]), { polyphonic: true });
    expect(plan.blocks.apply?.[0]).toMatchObject({ nodeId: COORD, isNew: false, params });
  });

  it("never offers it without MIDI, in Away mode or in practice", () => {
    const due = learningCoord([{ fam: "A", prog: ["I", "IV", "V", "I"], mel: 1, dueInDays: -1 }]);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000 }), (seed) => {
        for (const state of [learningCoord(), due]) {
          expect(coordItems(compose(state, { seed }))).toEqual([]);
          expect(coordItems(compose(state, { seed, polyphonic: false }))).toEqual([]);
          expect(coordItems(compose(state, { seed, polyphonic: true, mode: "away" }))).toEqual([]);
          expect(coordItems(compose(state, { seed, polyphonic: true, practice: true }))).toEqual(
            [],
          );
        }
      }),
      { numRuns: 30 },
    );
  });
});
