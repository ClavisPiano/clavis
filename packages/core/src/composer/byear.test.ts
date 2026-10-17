import { describe, expect, it } from "vitest";
import type { NodeState, SkillGraph, SkillNode } from "../graph/schema.js";
import { GENERATORS } from "../items/registry.js";
import type { LearnerState } from "../state/types.js";
import { composeSession } from "./compose.js";
import { V1_GRAPH } from "./fixtures/graph.js";
import { NOW } from "./fixtures/learners.js";
import { STUB_READ_GENERATORS, readLearner } from "./fixtures/read.js";
import type { SessionPlan } from "./types.js";

/*
 * BYEAR (T7.2): `byear.melody.simple` is a task node. Its melodies are offered in the Apply block,
 * one new melody per session, introduced like any other node once its prerequisite is mastered.
 */

const CELLS = "ear.cells.major.2-4";
const BYEAR = "byear.melody.simple";

const byearNode: SkillNode = {
  id: BYEAR,
  strand: "BYEAR",
  title: "Play a heard melody",
  prerequisites: [CELLS],
  itemGenerators: ["byEarPhrase"],
  params: { bars: [4, 8], diatonic: true, stages: ["melody"] },
  mastery: { minAccuracy: 0.8, windowAttempts: 5, distinctSessions: 2 },
  keyDependent: false,
};

const graph: SkillGraph = {
  ...V1_GRAPH,
  generators: V1_GRAPH.generators.map((g) =>
    g.id === "byEarPhrase"
      ? { ...g, implemented: true, seedDurationSec: 90, requires: ["mic", "keys", "notation"] }
      : g,
  ),
  nodes: [...V1_GRAPH.nodes.filter((n) => n.id !== BYEAR), byearNode],
};
const generators = { ...GENERATORS, ...STUB_READ_GENERATORS };

const learner = (
  byear: NodeState,
  o: { cells?: NodeState; cards?: [number, number, number][]; newToday?: number } = {},
): LearnerState =>
  readLearner({
    graph,
    nodes: { [CELLS]: o.cells ?? "mastered", [BYEAR]: byear },
    cards: (o.cards ?? []).map(([bars, slot, dueInDays]) => ({
      nodeId: BYEAR,
      params: { bars, slot },
      dueInDays,
    })),
    ...(o.newToday === undefined ? {} : { newToday: o.newToday }),
  });

const compose = (
  state: LearnerState,
  o: { mode?: "instrument" | "away"; practice?: boolean; budgetSec?: number } = {},
): SessionPlan =>
  composeSession({
    state,
    graph,
    now: NOW,
    tzOffsetMin: 0,
    seed: 7,
    generators,
    mode: o.mode ?? "instrument",
    ...(o.practice ? { practice: true } : {}),
    ...(o.budgetSec ? { budgetSec: o.budgetSec } : {}),
  });

const byear = (plan: SessionPlan) => (plan.blocks.apply ?? []).filter((i) => i.nodeId === BYEAR);

describe("Apply block: by-ear melodies (T7.2)", () => {
  it("introduces the node and offers its first melody in the Apply block", () => {
    const plan = compose(learner("available"));
    const items = byear(plan);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      itemId: `${BYEAR}|bars=4|slot=1`,
      generator: "byEarPhrase",
      isNew: true,
    });
    expect(plan.introductions).toContain(BYEAR);
    // Melodies are Apply content: never in the Ear or Read blocks.
    expect([...plan.blocks.ear, ...plan.blocks.read].some((i) => i.nodeId === BYEAR)).toBe(false);
  });

  it("offers one new melody per session, in universe order, once the node is learning", () => {
    const plan = compose(learner("learning", { cards: [[4, 1, 3]] }));
    const items = byear(plan);
    expect(items.map((i) => i.itemId)).toEqual([`${BYEAR}|bars=4|slot=2`]);
    expect(plan.introductions).not.toContain(BYEAR);
  });

  it("puts a due melody first and still adds the next new one", () => {
    const plan = compose(learner("learning", { cards: [[4, 1, -2]] }));
    const ids = byear(plan).map((i) => i.itemId);
    expect(ids[0]).toBe(`${BYEAR}|bars=4|slot=1`);
    expect(byear(plan)[0]?.isNew).toBe(false);
    expect(ids).toContain(`${BYEAR}|bars=4|slot=2`);
  });

  it("offers only due melodies once the node is mastered", () => {
    const none = compose(learner("mastered", { cards: [[4, 1, 5]] }));
    expect(byear(none)).toEqual([]);
    const due = compose(learner("mastered", { cards: [[4, 1, -1]] }));
    expect(byear(due).map((i) => i.itemId)).toEqual([`${BYEAR}|bars=4|slot=1`]);
  });

  it("stays out of the plan while the prerequisite is not mastered", () => {
    const plan = compose(learner("locked", { cells: "learning" }));
    expect(byear(plan)).toEqual([]);
    expect(plan.introductions).not.toContain(BYEAR);
  });

  it("defers the introduction when the daily new-item cap is reached", () => {
    const plan = compose(learner("available", { newToday: 99 }));
    expect(byear(plan)).toEqual([]);
    expect(plan.introductions).not.toContain(BYEAR);
  });

  it("is not offered in Away mode or in practice", () => {
    expect(byear(compose(learner("available"), { mode: "away" }))).toEqual([]);
    expect(
      byear(compose(learner("learning", { cards: [[4, 1, -1]] }), { practice: true })),
    ).toEqual([]);
  });

  it("is dropped under time pressure, like the rest of Apply", () => {
    expect(compose(learner("available"), { budgetSec: 240 }).blocks.apply).toBeNull();
  });

  it("is deterministic", () => {
    expect(compose(learner("available"))).toEqual(compose(learner("available")));
  });
});
