import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { encodeTime } from "../events/ulid.js";
import type { LearningEvent } from "../events/schema.js";
import type { SkillGraph } from "../graph/schema.js";
import { MAX_DRILLS_PER_NODE } from "../items/drill.js";
import { at } from "../theory/util.js";
import { foldEvents, initialState, REDUCER_VERSION, TASK_ROLLING_ALPHA } from "./reduce.js";
import { makeSnapshot, restoreSnapshot } from "./snapshot.js";
import type { LearnerState } from "./types.js";
import { Builder, DAY_MS, FIXTURE_GRAPH, T0, ctx } from "./test-helpers.js";

/* Task priority inputs and micro-drills (T5.8, R27). */

const HANDS = "h1";
const BYEAR = "b1";
const ROOT = at(FIXTURE_GRAPH.nodes, 0);
const GRAPH: SkillGraph = {
  ...FIXTURE_GRAPH,
  nodes: [
    ...FIXTURE_GRAPH.nodes,
    { ...ROOT, id: HANDS, strand: "HANDS" },
    { ...ROOT, id: BYEAR, strand: "BYEAR" },
  ],
};
const C = ctx(GRAPH);
const fold = (events: readonly LearningEvent[]) => foldEvents(events, C);

const drillId = (change: string, nodeId = HANDS): string => `${nodeId}|drill=${change}|fam=A`;
const SOURCE = `${HANDS}|fam=A|prog=I-IV-V-I`;

let drillSeq = 0;
function spawned(t: number, sessionId: string, itemIds: string[], nodeId = HANDS): LearningEvent {
  drillSeq++;
  return {
    id: `${encodeTime(t)}D${String(drillSeq).padStart(15, "0")}`,
    deviceId: "dev-a",
    at: t,
    type: "drill.spawned",
    v: 1,
    sessionId,
    sourceItemId: `${nodeId}|fam=A|prog=I-IV-V-I`,
    nodeId,
    itemIds,
  };
}

describe("task records", () => {
  it("start empty, and only HANDS and BYEAR nodes get one", () => {
    expect(initialState(C).tasks).toEqual({});
    expect(initialState(C).drills).toEqual({});
    const b = new Builder();
    const s = b.sessionId(1);
    const state = fold([
      b.start(T0, s),
      ...b.item(T0 + 1000, s, "n1", "n1:0"),
      ...b.item(T0 + 5000, s, HANDS, SOURCE, { partial: 0.6, correct: false }),
      ...b.item(T0 + 9000, s, BYEAR, `${BYEAR}|bars=4|slot=1`, { correct: true }),
    ]);
    expect(Object.keys(state.tasks).sort()).toEqual([BYEAR, HANDS]);
    expect(state.tasks[HANDS]).toEqual({ lastPracticedAt: T0 + 6500, rolling: 0.6 });
    expect(state.tasks[BYEAR]).toEqual({ lastPracticedAt: T0 + 10_500, rolling: 1 });
  });

  it.each<[string, { correct: boolean; partial?: number }[], number]>([
    ["one wrong attempt", [{ correct: false }], 0],
    ["one partial", [{ correct: false, partial: 0.5 }], 0.5],
    ["partial then correct", [{ correct: false, partial: 0.5 }, { correct: true }], 0.65],
    [
      "partial, correct, wrong",
      [{ correct: false, partial: 0.5 }, { correct: true }, { correct: false }],
      0.455,
    ],
    ["partial wins over correctness", [{ correct: true }, { correct: true, partial: 0 }], 0.7],
  ])("rolling score: %s", (_name, attempts, rolling) => {
    const b = new Builder();
    const s = b.sessionId(1);
    const events: LearningEvent[] = [b.start(T0, s)];
    attempts.forEach((a, i) => {
      events.push(...b.item(T0 + 1000 + i * 5000, s, HANDS, SOURCE, a));
    });
    expect(fold(events).tasks[HANDS]?.rolling).toBeCloseTo(rolling, 10);
    expect(TASK_ROLLING_ALPHA).toBe(0.3);
  });

  it("leaves drill attempts out of the task", () => {
    const b = new Builder();
    const s = b.sessionId(1);
    const state = fold([
      b.start(T0, s),
      ...b.item(T0 + 1000, s, HANDS, SOURCE, { correct: false, partial: 0.4 }),
      spawned(T0 + 3000, s, [drillId("IV-V")]),
      ...b.item(T0 + 4000, s, HANDS, drillId("IV-V"), { correct: true }),
    ]);
    expect(state.tasks[HANDS]).toEqual({ lastPracticedAt: T0 + 2500, rolling: 0.4 });
  });
});

describe("drill.spawned", () => {
  it("gives the drill a new card due at once", () => {
    const b = new Builder();
    const s = b.sessionId(1);
    const t = T0 + 3000;
    const state = fold([
      b.start(T0, s),
      ...b.item(T0 + 1000, s, HANDS, SOURCE, { correct: false }),
      spawned(t, s, [drillId("IV-V")]),
    ]);
    expect(state.drills[HANDS]).toEqual([drillId("IV-V")]);
    const card = state.cards[drillId("IV-V")];
    expect(card).toMatchObject({ nodeId: HANDS, reps: 0, lastAttemptAt: t });
    expect(card?.card.due).toBe(t);
    expect(card?.card.state).toBe("new");
    expect(card !== undefined && C.scheduler.isDue(card.card, t)).toBe(true);
  });

  it("then schedules it as an ordinary FSRS card", () => {
    const b = new Builder();
    const s = b.sessionId(1);
    const state = fold([
      b.start(T0, s),
      spawned(T0 + 1000, s, [drillId("IV-V")]),
      ...b.item(T0 + 2000, s, HANDS, drillId("IV-V"), { correct: true }),
    ]);
    const card = state.cards[drillId("IV-V")];
    expect(card?.reps).toBe(1);
    expect(card?.card.due).toBeGreaterThan(T0 + 3500);
  });

  it(`keeps at most ${String(MAX_DRILLS_PER_NODE)} per node: a new one retires the oldest`, () => {
    const b = new Builder();
    const s = b.sessionId(1);
    const changes = ["IV-V", "V-I", "I-vi", "vi-IV"];
    const state = fold([
      b.start(T0, s),
      ...changes.map((c, i) => spawned(T0 + 1000 * (i + 1), s, [drillId(c)])),
      // Another node's drills are counted separately.
      spawned(T0 + 9000, s, [drillId("I-IV", BYEAR)], BYEAR),
    ]);
    expect(state.drills[HANDS]).toEqual(changes.slice(1).map((c) => drillId(c)));
    expect(state.cards[drillId("IV-V")]).toBeUndefined();
    for (const c of changes.slice(1)) expect(state.cards[drillId(c)]).toBeDefined();
    expect(state.drills[BYEAR]).toEqual([drillId("I-IV", BYEAR)]);
  });

  it("gives a retired drill no card back when it is attempted", () => {
    const b = new Builder();
    const s = b.sessionId(1);
    const changes = ["IV-V", "V-I", "I-vi", "vi-IV"];
    const state = fold([
      b.start(T0, s),
      ...changes.map((c, i) => spawned(T0 + 1000 * (i + 1), s, [drillId(c)])),
      ...b.item(T0 + 10_000, s, HANDS, drillId("IV-V"), { correct: true }),
    ]);
    expect(state.cards[drillId("IV-V")]).toBeUndefined();
    expect(state.attempts[HANDS]).toHaveLength(1);
  });

  it("makes a live drill due again when the same change goes wrong", () => {
    const b = new Builder();
    const s1 = b.sessionId(1);
    const s2 = b.sessionId(2);
    const later = T0 + 2 * DAY_MS;
    const state = fold([
      b.start(T0, s1),
      spawned(T0 + 1000, s1, [drillId("IV-V")]),
      ...b.item(T0 + 2000, s1, HANDS, drillId("IV-V"), { correct: true }),
      ...b.item(T0 + 9000, s1, HANDS, drillId("IV-V"), { correct: true }),
      b.start(later, s2),
      spawned(later + 1000, s2, [drillId("IV-V")]),
    ]);
    const card = state.cards[drillId("IV-V")];
    expect(card?.reps).toBe(2);
    expect(card?.card.due).toBe(later + 1000);
    expect(state.drills[HANDS]).toEqual([drillId("IV-V")]);
  });

  it("is ignored in practice and counted as a warning for an unknown node", () => {
    const b = new Builder();
    const s = b.sessionId(1);
    const state = fold([
      b.start(T0, s, { practice: true }),
      spawned(T0 + 1000, s, [drillId("IV-V")]),
      spawned(T0 + 2000, s, [drillId("IV-V", "nope")], "nope"),
    ]);
    expect(state.cards).toEqual({});
    expect(state.drills[HANDS] ?? []).toEqual([]);
    expect(state.warnings).toBe(1);
  });
});

interface Step {
  kind: "source" | "drill" | "drillAttempt" | "byear";
  change: string;
  correct: boolean;
  partial: number | undefined;
}

describe("refold", () => {
  const step: fc.Arbitrary<Step> = fc.record({
    kind: fc.constantFrom("source", "drill", "drillAttempt", "byear"),
    change: fc.constantFrom("IV-V", "V-I", "I-vi", "vi-IV", "I-IV"),
    correct: fc.boolean(),
    partial: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: undefined }),
  });

  function history(steps: readonly Step[]): LearningEvent[] {
    const b = new Builder();
    const s = b.sessionId(1);
    const events: LearningEvent[] = [b.start(T0, s)];
    steps.forEach((st, i) => {
      const t = T0 + 1000 + i * 10_000;
      const o = {
        correct: st.correct,
        ...(st.partial === undefined ? {} : { partial: st.partial }),
      };
      if (st.kind === "source") events.push(...b.item(t, s, HANDS, SOURCE, o));
      else if (st.kind === "byear") events.push(...b.item(t, s, BYEAR, `${BYEAR}|slot=1`, o));
      else if (st.kind === "drill") events.push(spawned(t, s, [drillId(st.change)]));
      else events.push(...b.item(t, s, HANDS, drillId(st.change), o));
    });
    return events;
  }

  it("is order independent and idempotent", () => {
    fc.assert(
      fc.property(
        fc.array(step, { maxLength: 25 }),
        fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 80, maxLength: 80 }),
        (steps, keys) => {
          const events = history(steps);
          const shuffled = events
            .map((e, i) => ({ e, k: keys[i % keys.length] ?? 0 }))
            .sort((a, b) => a.k - b.k)
            .map((x) => x.e);
          const once = fold(events);
          expect(fold(shuffled)).toEqual(once);
          expect(fold([...shuffled, ...events])).toEqual(once);
          expect((once.drills[HANDS] ?? []).length).toBeLessThanOrEqual(MAX_DRILLS_PER_NODE);
          for (const id of once.drills[HANDS] ?? []) expect(once.cards[id]).toBeDefined();
          const drillCards = Object.keys(once.cards).filter((id) => id.includes("drill="));
          expect(drillCards.sort()).toEqual([...(once.drills[HANDS] ?? [])].sort());
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("snapshots", () => {
  it("use the bumped reducer version and need the task fields", () => {
    expect(REDUCER_VERSION).toBe(7);
    const state = initialState(C);
    const snap = makeSnapshot(state, "c1");
    expect(restoreSnapshot(snap, "c1")).toEqual(state);
    const withoutTasks: Partial<LearnerState> = { ...state };
    delete withoutTasks.tasks;
    expect(restoreSnapshot({ ...snap, state: withoutTasks }, "c1")).toBeUndefined();
    const withoutDrills: Partial<LearnerState> = { ...state };
    delete withoutDrills.drills;
    expect(restoreSnapshot({ ...snap, state: withoutDrills }, "c1")).toBeUndefined();
  });
});
