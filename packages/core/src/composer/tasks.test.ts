import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { SkillGraph, SkillNode } from "../graph/schema.js";
import { itemId } from "../items/ids.js";
import { GENERATORS } from "../items/registry.js";
import type { LearnerState, TaskRecord } from "../state/types.js";
import { composeSession, HANDS_NEW_ITEMS_PER_SESSION } from "./compose.js";
import { HANDS_ROOT } from "./fixtures/graph.js";
import { D135, NOW } from "./fixtures/learners.js";
import { READ_GRAPH, STUB_READ_GENERATORS, readLearner } from "./fixtures/read.js";
import { pickTask, taskPriority, taskRecords } from "./task.js";
import type { PlannedItem, SessionPlan } from "./types.js";

/* Task priority and micro-drills in the Apply block (T5.8, spec 5.4 and 6.2, R27). */

const DAY = 86_400_000;
const LH = HANDS_ROOT;
const COORD = "hands.coord.basic";
const BYEAR = "byear.melody.simple";

describe("taskPriority", () => {
  it.each<[string, TaskRecord | undefined, number]>([
    ["never practised", undefined, Infinity],
    ["two days ago, half right", { lastPracticedAt: NOW - 2 * DAY, rolling: 0.5 }, 1],
    ["ten days ago, 0.9", { lastPracticedAt: NOW - 10 * DAY, rolling: 0.9 }, 1],
    ["a day ago, all wrong", { lastPracticedAt: NOW - DAY, rolling: 0 }, 1],
    ["six hours ago, all wrong", { lastPracticedAt: NOW - DAY / 4, rolling: 0 }, 0.25],
    ["just now", { lastPracticedAt: NOW, rolling: 0 }, 0],
    ["a perfect score", { lastPracticedAt: NOW - 30 * DAY, rolling: 1 }, 0],
    ["in the future (clock skew)", { lastPracticedAt: NOW + DAY, rolling: 0 }, 0],
  ])("%s", (_name, record, expected) => {
    expect(taskPriority(record, NOW)).toBeCloseTo(expected, 10);
  });
});

describe("pickTask", () => {
  const rec = (days: number, rolling: number): TaskRecord => ({
    lastPracticedAt: NOW - days * DAY,
    rolling,
  });
  it.each<[string, Record<string, TaskRecord | undefined>, string]>([
    ["the highest priority", { a: rec(1, 0.5), b: rec(4, 0.5), c: rec(3, 0.5) }, "b"],
    ["weak beats stale", { a: rec(10, 0.95), b: rec(2, 0.2) }, "b"],
    ["stale beats weak", { a: rec(10, 0.8), b: rec(2, 0.2) }, "a"],
    ["never practised first", { a: rec(30, 0), b: undefined }, "b"],
    ["ties to the one practised longest ago", { a: rec(1, 1), b: rec(5, 1), c: rec(3, 1) }, "b"],
  ])("%s", (_name, tasks, expected) => {
    const records = Object.fromEntries(
      Object.entries(tasks).flatMap(([k, v]) => (v === undefined ? [] : [[k, v]])),
    ) as Record<string, TaskRecord>;
    expect(pickTask(Object.keys(tasks), records, NOW)).toBe(expected);
  });

  it("breaks a full tie by graph order, and has nothing to pick from no nodes", () => {
    expect(pickTask(["c", "a", "b"], {}, NOW)).toBe("c");
    expect(pickTask([], {}, NOW)).toBeUndefined();
  });

  it("counts a placed node without attempts as just practised and perfect", () => {
    const state = readLearner({
      nodes: { [LH]: "fluent", [COORD]: "learning" },
    });
    const records = taskRecords([LH, COORD], state, NOW);
    expect(records).toEqual({ [LH]: { lastPracticedAt: NOW, rolling: 1 } });
    expect(pickTask([LH, COORD], records, NOW)).toBe(COORD);
  });
});

/* The composer: the root chords, hands together and a by-ear melody node, all MIDI-ready. */

function taskGraph(): SkillGraph {
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
  const byear: SkillNode = {
    id: BYEAR,
    strand: "BYEAR",
    title: "Play a heard melody",
    prerequisites: [],
    itemGenerators: ["byEarPhrase"],
    params: { bars: [4, 8], diatonic: true, stages: ["melody"] },
    mastery: { minAccuracy: 0.8, windowAttempts: 5, distinctSessions: 2 },
    keyDependent: false,
  };
  return {
    ...READ_GRAPH,
    generators: READ_GRAPH.generators.map((g) =>
      g.id === "coordTask" || g.id === "byEarPhrase"
        ? { ...g, implemented: true, seedDurationSec: 45 }
        : g,
    ),
    nodes: [...READ_GRAPH.nodes.filter((n) => n.id !== BYEAR), coord, byear],
  };
}

const GRAPH = taskGraph();
const generators = { ...GENERATORS, ...STUB_READ_GENERATORS };

const compose = (state: LearnerState, seed = 42): SessionPlan =>
  composeSession({
    graph: GRAPH,
    now: NOW,
    tzOffsetMin: 0,
    seed,
    generators,
    state,
    mode: "instrument",
    polyphonic: true,
    budgetSec: 1800,
  });

const LH_DUE = { fam: "A", prog: ["I", "IV", "V", "I"] };
const COORD_DUE = { fam: "A", prog: ["I", "V", "vi", "IV"], mel: 2 };
const BYEAR_DUE = { bars: 4, slot: 1 };
const drillOf = (nodeId: string, change: string): string => `${nodeId}|drill=${change}|fam=A`;

/** All three tasks learning with one due item each, and the given task records and drills. */
function learner(
  tasks: Record<string, TaskRecord>,
  drills: Record<string, { change: string; dueInDays: number }[]> = {},
): LearnerState {
  const state = readLearner({
    graph: GRAPH,
    nodes: {
      [D135]: "mastered",
      [LH]: { state: "learning", byFamily: { A: "learning" }, introducedAt: NOW - 30 * DAY },
      [COORD]: { state: "learning", byFamily: { A: "learning" }, introducedAt: NOW - 20 * DAY },
      [BYEAR]: { state: "learning", introducedAt: NOW - 20 * DAY },
    },
    cards: [
      { nodeId: LH, params: LH_DUE, dueInDays: -1 },
      { nodeId: COORD, params: COORD_DUE, dueInDays: -1 },
      { nodeId: BYEAR, params: BYEAR_DUE, dueInDays: -1 },
    ],
  });
  state.tasks = tasks;
  for (const [nodeId, list] of Object.entries(drills)) {
    state.drills[nodeId] = list.map((d) => drillOf(nodeId, d.change));
    for (const d of list) {
      const card = state.cards[itemId(LH, LH_DUE)];
      if (!card) throw new Error("no template card");
      state.cards[drillOf(nodeId, d.change)] = {
        ...card,
        nodeId,
        card: { ...card.card, due: NOW + d.dueInDays * DAY },
      };
    }
  }
  return state;
}

const rec = (days: number, rolling: number): TaskRecord => ({
  lastPracticedAt: NOW - days * DAY,
  rolling,
});
const taskNodes = new Set([LH, COORD, BYEAR]);
const applyTasks = (p: SessionPlan): PlannedItem[] =>
  (p.blocks.apply ?? []).filter((i) => taskNodes.has(i.nodeId));
const summary = (p: SessionPlan): string[] =>
  applyTasks(p).map((i) => `${i.isNew ? "new" : "due"} ${i.itemId}`);

describe("Apply works on one task", () => {
  it("chooses hands together when it is the most neglected", () => {
    const plan = compose(
      learner({ [LH]: rec(1, 0.5), [COORD]: rec(4, 0.5), [BYEAR]: rec(2, 0.5) }),
    );
    expect(plan.diagnostics.notes).toContain(`apply task: ${COORD}`);
    expect(summary(plan)).toEqual([
      "due hands.coord.basic|fam=A|mel=2|prog=I-V-vi-IV",
      "new hands.coord.basic|fam=A|mel=1|prog=I-IV-I-IV",
      "new hands.coord.basic|fam=A|mel=2|prog=I-IV-I-IV",
    ]);
  });

  it("chooses the root chords when they went worst", () => {
    const plan = compose(learner({ [LH]: rec(2, 0), [COORD]: rec(4, 0.9), [BYEAR]: rec(3, 0.8) }));
    expect(summary(plan)).toEqual([
      "due hands.lh.triads.root|fam=A|prog=I-IV-V-I",
      "new hands.lh.triads.root|fam=A|prog=I-IV-I-IV",
      "new hands.lh.triads.root|fam=A|prog=I-IV-I-V",
    ]);
  });

  it("chooses the by-ear melodies by the same rule", () => {
    const plan = compose(
      learner({ [LH]: rec(1, 0.5), [COORD]: rec(1, 0.5), [BYEAR]: rec(9, 0.5) }),
    );
    expect(summary(plan)).toEqual([
      "due byear.melody.simple|bars=4|slot=1",
      "new byear.melody.simple|bars=4|slot=2",
    ]);
  });

  it("works on a task never practised before any other", () => {
    const plan = compose(learner({ [LH]: rec(9, 0), [COORD]: rec(9, 0) }));
    expect(new Set(applyTasks(plan).map((i) => i.nodeId))).toEqual(new Set([BYEAR]));
  });

  it("offers at most the task's own new-item limit", () => {
    const plan = compose(learner({ [LH]: rec(9, 0), [COORD]: rec(1, 0), [BYEAR]: rec(1, 0) }));
    expect(applyTasks(plan).filter((i) => i.isNew).length).toBeLessThanOrEqual(
      HANDS_NEW_ITEMS_PER_SESSION,
    );
  });

  it("always plans items of one task node only, whatever the records", () => {
    const record = fc.option(
      fc.record({
        lastPracticedAt: fc.integer({ min: NOW - 60 * DAY, max: NOW }),
        rolling: fc.double({ min: 0, max: 1, noNaN: true }),
      }),
      { nil: undefined },
    );
    fc.assert(
      fc.property(record, record, record, fc.integer({ min: 0, max: 1000 }), (a, b, c, seed) => {
        const tasks: Record<string, TaskRecord> = {};
        if (a) tasks[LH] = a;
        if (b) tasks[COORD] = b;
        if (c) tasks[BYEAR] = c;
        const plan = compose(learner(tasks), seed);
        const nodes = new Set(applyTasks(plan).map((i) => i.nodeId));
        expect(nodes.size).toBe(1);
        expect(applyTasks(plan).some((i) => i.itemId.includes("drill="))).toBe(false);
      }),
      { numRuns: 60 },
    );
  });
});

describe("micro-drills in Apply", () => {
  it("come first when due, from any task node, before the chosen task", () => {
    const plan = compose(
      learner(
        { [LH]: rec(1, 0.5), [COORD]: rec(4, 0.5), [BYEAR]: rec(2, 0.5) },
        {
          [LH]: [
            { change: "IV-V", dueInDays: -2 },
            { change: "V-I", dueInDays: 3 },
          ],
          [COORD]: [{ change: "vi-IV", dueInDays: 0 }],
        },
      ),
    );
    expect(summary(plan)).toEqual([
      "due hands.lh.triads.root|drill=IV-V|fam=A",
      "due hands.coord.basic|drill=vi-IV|fam=A",
      "due hands.coord.basic|fam=A|mel=2|prog=I-V-vi-IV",
      "new hands.coord.basic|fam=A|mel=1|prog=I-IV-I-IV",
      "new hands.coord.basic|fam=A|mel=2|prog=I-IV-I-IV",
    ]);
    const drill = plan.blocks.apply?.[0];
    expect(drill).toMatchObject({
      nodeId: LH,
      generator: "lhPattern",
      params: { fam: "A", drill: "IV-V" },
      fam: "A",
      isNew: false,
    });
    expect(drill?.itemId).toBe(itemId(LH, drill?.params ?? {}));
  });

  it("are never offered as new and never planned once retired", () => {
    const state = learner({ [LH]: rec(1, 0.5) }, { [LH]: [{ change: "IV-V", dueInDays: -1 }] });
    // A card left behind without a live drill entry is not planned.
    state.drills[LH] = [];
    expect(summary(compose(state)).some((s) => s.includes("drill="))).toBe(false);
  });

  it("are not planned in practice or Away", () => {
    const state = learner({}, { [LH]: [{ change: "IV-V", dueInDays: -1 }] });
    for (const extra of [{ practice: true as const }, { mode: "away" as const }]) {
      const plan = composeSession({
        graph: GRAPH,
        now: NOW,
        tzOffsetMin: 0,
        seed: 1,
        generators,
        state,
        mode: "instrument",
        polyphonic: true,
        ...extra,
      });
      expect([...plan.blocks.ear, ...plan.blocks.read, ...(plan.blocks.apply ?? [])]).toEqual(
        expect.not.arrayContaining([expect.objectContaining({ itemId: drillOf(LH, "IV-V") })]),
      );
    }
  });
});
