import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { SkillGraph, SkillNode } from "../graph/schema.js";
import { GENERATORS } from "../items/registry.js";
import { createRng } from "../random.js";
import type { LearnerState } from "../state/types.js";
import { keyFamily } from "../theory/keys.js";
import { composeSession } from "./compose.js";
import { D135, NOW } from "./fixtures/learners.js";
import {
  LANDMARKS,
  READ_GRAPH,
  STEPS,
  STUB_READ_GENERATORS,
  readLearner,
  type CardSpec,
} from "./fixtures/read.js";
import type { PlannedItem, SessionPlan } from "./types.js";

/*
 * The Read block's closing line (T5.11, spec 6.2, R18): once the grand-staff reading node is
 * started, the Read block ends with one short line in the key of the day. MIDI only, never Away.
 */

const TWO_LINE = "read.grand.2line";
const SIGHT = "read.grand.sight";
const DAY = 86_400_000;

const lineNode = (id: string, extra: Partial<SkillNode>): SkillNode => ({
  id,
  strand: "READ",
  title: id,
  prerequisites: [],
  itemGenerators: ["sightLine"],
  params: {},
  mastery: { minAccuracy: 0.85, windowAttempts: 10, distinctSessions: 2 },
  keyDependent: true,
  ...extra,
});

const GRAPH: SkillGraph = {
  ...READ_GRAPH,
  generators: READ_GRAPH.generators.map((g) =>
    g.id === "sightLine" ? { ...g, implemented: true } : g,
  ),
  nodes: [
    ...READ_GRAPH.nodes,
    lineNode(TWO_LINE, {
      prerequisites: [STEPS],
      params: { staves: "grand", bars: [2, 4], style: "lines", keyOfDay: true },
    }),
    lineNode(SIGHT, {
      prerequisites: [TWO_LINE],
      params: { staves: "grand", bars: [4, 8], style: "sight", graded: true },
    }),
  ],
};
const generators = { ...GENERATORS, ...STUB_READ_GENERATORS };

const compose = (
  state: LearnerState,
  o: {
    polyphonic?: boolean;
    mode?: "instrument" | "away";
    budgetSec?: number;
    seed?: number;
  } = {},
): SessionPlan =>
  composeSession({
    graph: GRAPH,
    generators,
    now: NOW,
    tzOffsetMin: 0,
    seed: o.seed ?? 42,
    state,
    mode: o.mode ?? "instrument",
    polyphonic: o.polyphonic ?? true,
    ...(o.budgetSec ? { budgetSec: o.budgetSec } : {}),
  });

const lines = (p: SessionPlan): PlannedItem[] =>
  [...p.blocks.ear, ...p.blocks.read, ...(p.blocks.apply ?? [])].filter(
    (i) => i.generator === "sightLine",
  );

/** Bass reading fluent, steps still learning, and the two-staff node at `twoLine`. */
function learner(twoLine: "available" | "learning", cards: CardSpec[] = []): LearnerState {
  return readLearner({
    graph: GRAPH,
    nodes: {
      [D135]: "mastered",
      [LANDMARKS]: { state: "fluent", byFamily: { A: "fluent" }, introducedAt: NOW - 20 * DAY },
      [STEPS]: { state: "learning", byFamily: { A: "learning" }, introducedAt: NOW - 9 * DAY },
      [TWO_LINE]:
        twoLine === "learning"
          ? { state: "learning", byFamily: { A: "learning" }, introducedAt: NOW - 3 * DAY }
          : "available",
    },
    cards,
  });
}

describe("the Read block's closing line", () => {
  it("ends the Read block with one new line in the key of the day", () => {
    const plan = compose(learner("learning"));
    const read = plan.blocks.read;
    const last = read.at(-1);
    expect(last?.nodeId).toBe(TWO_LINE);
    expect(last?.generator).toBe("sightLine");
    expect(last?.isNew).toBe(true);
    // The rest of the block is ordinary reading, and the line is the only one in the session.
    expect(read.length).toBeGreaterThan(1);
    expect(lines(plan)).toHaveLength(1);
    // The key of the day: family A is open, and C-major-first no longer applies.
    expect(keyFamily(plan.key)).toBe("A");
    expect(last?.fam).toBe("A");
    expect(last?.key).toEqual(plan.key);
    expect(plan.diagnostics.notes).toContain(`closing line: ${String(last?.itemId)}`);
    // Its time is part of the Read block's: the plan still fits the budget.
    expect(plan.estimatedSec).toBeLessThanOrEqual(plan.budgetSec);
  });

  it("generates the planned line in that key", () => {
    const plan = compose(learner("learning"));
    const last = plan.blocks.read.at(-1);
    if (last === undefined) throw new Error("no closing line");
    const node = GRAPH.nodes.find((n) => n.id === last.nodeId);
    if (node === undefined) throw new Error("unknown node");
    const inst = GENERATORS.sightLine?.generate(node, last.params, {
      rng: createRng(1),
      mode: "instrument",
      ...(last.key ? { preferredKey: last.key } : {}),
    });
    expect(inst?.presentation.tonic).toBe(plan.key.tonic);
    expect(inst?.expected.play?.kind).toBe("performance");
  });

  it("prefers a due line, in the key of the day's family first, over a new one", () => {
    const plan = compose(
      learner("learning", [
        { nodeId: TWO_LINE, params: { fam: "B", bars: 4, slot: 2 }, dueInDays: -3 },
        { nodeId: TWO_LINE, params: { fam: "A", bars: 2, slot: 5 }, dueInDays: -1 },
      ]),
    );
    const closing = lines(plan);
    expect(closing).toHaveLength(1);
    expect(closing[0]?.itemId).toBe(`${TWO_LINE}|bars=2|fam=A|slot=5`);
    expect(closing[0]?.isNew).toBe(false);
    expect(plan.blocks.read.at(-1)).toBe(closing[0]);
  });

  it("draws on sight-reading too once that node is started", () => {
    const state = learner("learning", [
      { nodeId: SIGHT, params: { fam: "A", bars: 8, slot: 1 }, dueInDays: -2 },
    ]);
    state.nodes[SIGHT] = { state: "learning", byFamily: { A: "learning" } };
    const plan = compose(state);
    expect(lines(plan).map((i) => i.itemId)).toEqual([`${SIGHT}|bars=8|fam=A|slot=1`]);
  });

  it("introduces the two-staff node through its closing line", () => {
    const state = readLearner({
      graph: GRAPH,
      nodes: {
        [D135]: "mastered",
        [LANDMARKS]: { state: "fluent", byFamily: { A: "fluent" }, introducedAt: NOW - 20 * DAY },
        [STEPS]: { state: "fluent", byFamily: { A: "fluent" }, introducedAt: NOW - 9 * DAY },
        [TWO_LINE]: "available",
      },
    });
    const plan = compose(state);
    expect(plan.introductions).toEqual([TWO_LINE]);
    expect(plan.introductionKeyFamilies).toEqual({ [TWO_LINE]: "A" });
    expect(plan.blocks.read.at(-1)?.nodeId).toBe(TWO_LINE);
  });

  it("is not planned while the node is only available and not being introduced", () => {
    // Steps are mid-learning, so READ introduces nothing.
    const plan = compose(learner("available"));
    expect(plan.introductions).not.toContain(TWO_LINE);
    expect(lines(plan)).toEqual([]);
  });

  it("is not planned without polyphonic input, in Away, or when it does not fit", () => {
    expect(lines(compose(learner("learning"), { polyphonic: false }))).toEqual([]);
    expect(lines(compose(learner("learning"), { mode: "away" }))).toEqual([]);
    // A two-minute session has well under a minute of Read.
    const short = compose(learner("learning"), { budgetSec: 120 });
    expect(lines(short)).toEqual([]);
  });

  it("keeps a line last and alone, whatever the seed and budget", () => {
    const due: CardSpec[] = [1, 2, 3].map((slot) => ({
      nodeId: TWO_LINE,
      params: { fam: "A", bars: 4, slot },
      dueInDays: -slot,
    }));
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0x7fffffff }),
        fc.integer({ min: 60, max: 1800 }),
        fc.boolean(),
        (seed, budgetSec, withDue) => {
          const plan = compose(learner("learning", withDue ? due : []), { seed, budgetSec });
          const found = lines(plan);
          expect(found.length).toBeLessThanOrEqual(1);
          if (found[0] !== undefined) expect(plan.blocks.read.at(-1)).toBe(found[0]);
        },
      ),
      { numRuns: 80 },
    );
  });
});
