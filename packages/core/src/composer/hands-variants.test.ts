import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { SkillGraph, SkillNode } from "../graph/schema.js";
import { itemId } from "../items/ids.js";
import { GENERATORS } from "../items/registry.js";
import type { LearnerState } from "../state/types.js";
import { composeSession, HANDS_NEW_ITEMS_PER_SESSION } from "./compose.js";
import { HANDS_ROOT } from "./fixtures/graph.js";
import { D135, NOW } from "./fixtures/learners.js";
import { READ_GRAPH, STUB_READ_GENERATORS, readLearner } from "./fixtures/read.js";
import type { PlannedItem, SessionPlan } from "./types.js";

/*
 * Left-hand pattern variants (T5.7): inversions, broken and pop items are HANDS items like the
 * root-position chords, so they join the Apply block only with MIDI (polyphonic) input, never in
 * Away mode and never in practice rounds.
 */

const DAY = 86_400_000;
const CHORDS = ["I", "IV", "V", "vi"];
const mastery = { minAccuracy: 0.8, windowAttempts: 5, distinctSessions: 2 };
const node = (id: string, prerequisites: string[], params: SkillNode["params"]): SkillNode => ({
  id,
  strand: "HANDS",
  title: id,
  prerequisites,
  itemGenerators: ["lhPatternVariants"],
  params,
  mastery,
  keyDependent: true,
});
const INV = "hands.lh.inversions";
const BROKEN = "hands.lh.broken";
const POP = "hands.lh.pop";

const GRAPH: SkillGraph = {
  ...READ_GRAPH,
  nodes: [
    ...READ_GRAPH.nodes,
    node(INV, [HANDS_ROOT], {
      pattern: "block",
      voiceLeading: "close",
      inversions: ["root", "first", "second"],
      chords: CHORDS,
    }),
    node(BROKEN, [INV], { patterns: ["broken", "alberti"], chords: CHORDS }),
    node(POP, [BROKEN], { patterns: ["root-5-8", "syncopated"], chords: CHORDS }),
  ],
  generators: [
    ...READ_GRAPH.generators,
    {
      id: "lhPatternVariants",
      implemented: true,
      seedDurationSec: 30,
      awayEligible: false,
      requires: ["keys", "polyphonic", "notation"],
    },
  ],
};
const generators = { ...GENERATORS, ...STUB_READ_GENERATORS };

const compose = (
  state: LearnerState,
  o: { polyphonic?: boolean; mode?: "instrument" | "away"; practice?: boolean; seed?: number } = {},
): SessionPlan =>
  composeSession({
    graph: GRAPH,
    now: NOW,
    tzOffsetMin: 0,
    generators,
    state,
    mode: o.mode ?? "instrument",
    seed: o.seed ?? 42,
    ...(o.polyphonic === undefined ? {} : { polyphonic: o.polyphonic }),
    ...(o.practice ? { practice: true } : {}),
  });

const allItems = (p: SessionPlan): PlannedItem[] => [
  ...p.blocks.ear,
  ...p.blocks.read,
  ...(p.blocks.apply ?? []),
];
const variantItems = (p: SessionPlan): PlannedItem[] =>
  allItems(p).filter((i) => i.generator === "lhPatternVariants");

/** One variant node learning (its prerequisites mastered), the rest of HANDS settled. */
function learning(nodeId: string, cards: { params: object; dueInDays: number }[] = []) {
  const order = [HANDS_ROOT, INV, BROKEN, POP];
  const nodes: Parameters<typeof readLearner>[0]["nodes"] = { [D135]: "mastered" };
  for (const id of order.slice(0, order.indexOf(nodeId))) nodes[id] = "mastered";
  nodes[nodeId] = { state: "learning", byFamily: { A: "learning" }, introducedAt: NOW - 3 * DAY };
  return readLearner({
    graph: GRAPH,
    nodes,
    cards: cards.map((c) => ({ nodeId, params: c.params as never, dueInDays: c.dueInDays })),
  });
}

describe.each([INV, BROKEN, POP])("%s in the Apply block", (nodeId) => {
  it("offers new items with MIDI input, from this node, in C major while reading is new", () => {
    const plan = compose(learning(nodeId), { polyphonic: true });
    const items = variantItems(plan);
    expect(items).toHaveLength(HANDS_NEW_ITEMS_PER_SESSION);
    for (const item of items) {
      expect(item.nodeId).toBe(nodeId);
      expect(plan.blocks.apply).toContain(item);
      expect(item.isNew).toBe(true);
      expect(item.fam).toBe("A");
      expect(item.key).toEqual({ tonic: "C", mode: "major" });
      expect(item.itemId).toBe(itemId(nodeId, item.params));
      expect("pattern" in item.params).toBe(nodeId !== INV);
    }
  });

  it("puts a due item first with its stored params", () => {
    const params =
      nodeId === INV
        ? { fam: "A", prog: ["I", "vi", "IV", "V"] }
        : {
            fam: "A",
            pattern: nodeId === BROKEN ? "alberti" : "syncopated",
            prog: ["I", "V", "vi", "IV"],
          };
    const plan = compose(learning(nodeId, [{ params, dueInDays: -2 }]), { polyphonic: true });
    expect(plan.blocks.apply?.[0]).toMatchObject({ nodeId, isNew: false, params });
  });

  it("never appears without MIDI, in Away mode or in practice rounds", () => {
    const params =
      nodeId === INV
        ? { fam: "A", prog: ["I", "IV", "V", "I"] }
        : {
            fam: "A",
            pattern: nodeId === BROKEN ? "broken" : "root-5-8",
            prog: ["I", "IV", "V", "I"],
          };
    const state = learning(nodeId, [{ params, dueInDays: -1 }]);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000 }), (seed) => {
        expect(variantItems(compose(state, { seed }))).toEqual([]);
        expect(variantItems(compose(state, { seed, polyphonic: false }))).toEqual([]);
        expect(variantItems(compose(state, { seed, mode: "away", polyphonic: true }))).toEqual([]);
        expect(variantItems(compose(state, { seed, polyphonic: true, practice: true }))).toEqual(
          [],
        );
      }),
      { numRuns: 25 },
    );
  });
});

describe("introducing a variant node", () => {
  it("happens only with MIDI input", () => {
    const state = readLearner({
      graph: GRAPH,
      nodes: {
        [D135]: { state: "learning", introducedAt: NOW - 6 * DAY },
        [HANDS_ROOT]: "mastered",
        [INV]: "available",
      },
    });
    const withMidi = compose(state, { polyphonic: true });
    expect(withMidi.introductions).toEqual([INV]);
    expect(variantItems(withMidi).every((i) => i.nodeId === INV)).toBe(true);
    expect(variantItems(withMidi).length).toBeGreaterThan(0);
    const without = compose(state);
    expect(without.introductions).not.toContain(INV);
    expect(variantItems(without)).toEqual([]);
  });
});
