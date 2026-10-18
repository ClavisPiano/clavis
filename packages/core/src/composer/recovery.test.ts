import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { composeSession } from "./compose.js";
import { RECOVERY_MIN_BUDGET_SEC } from "./budget.js";
import { NOW, learnerAtDailyCap, learnerWithDueCards, newLearner } from "./fixtures/learners.js";
import { V1_GRAPH } from "./fixtures/graph.js";
import type { PlannedItem, SessionPlan } from "./types.js";

/* Welcome back (R30): a shorter session that only reviews. */

const base = { graph: V1_GRAPH, now: NOW, tzOffsetMin: 0, seed: 42 };
const items = (plan: SessionPlan): PlannedItem[] => [
  ...plan.blocks.ear,
  ...plan.blocks.read,
  ...(plan.blocks.apply ?? []),
];

describe("composeSession with recovery", () => {
  const state = learnerWithDueCards();

  it("halves the budget, takes nothing new and says so", () => {
    const normal = composeSession({ ...base, state, mode: "instrument" });
    const plan = composeSession({ ...base, state, mode: "instrument", recovery: true });
    expect(normal.budgetSec).toBe(720);
    expect(normal.blocks.ear.some((i) => i.isNew)).toBe(true);
    expect(plan.recovery).toBe(true);
    expect(plan.budgetSec).toBe(360);
    expect(items(plan).length).toBeGreaterThan(0);
    expect(items(plan).every((i) => !i.isNew)).toBe(true);
    expect(plan.introductions).toEqual([]);
    expect(plan.diagnostics.newAllowance).toBe(0);
    expect(plan.diagnostics.notes).toContain("welcome back: shorter, review only");
  });

  it("reviews only items that were due, and fits the shorter budget", () => {
    const normal = composeSession({ ...base, state, mode: "instrument", budgetSec: 3600 });
    const dueIds = new Set(
      items(normal)
        .filter((i) => !i.isNew)
        .map((i) => i.itemId),
    );
    const plan = composeSession({ ...base, state, mode: "instrument", recovery: true });
    for (const item of items(plan)) expect(dueIds.has(item.itemId)).toBe(true);
    expect(plan.estimatedSec).toBeLessThanOrEqual(plan.budgetSec);
    expect(plan.estimatedSec).toBeLessThan(normal.estimatedSec);
  });

  it("ignores the extra new items that Learn something new would grant", () => {
    const plan = composeSession({
      ...base,
      state,
      mode: "instrument",
      recovery: true,
      extraNewItems: 10,
    });
    expect(items(plan).some((i) => i.isNew)).toBe(false);
  });

  it("defers an introduction a new learner would get", () => {
    const fresh = composeSession({ ...base, state: newLearner(), mode: "instrument" });
    expect(fresh.introductions.length).toBe(1);
    const plan = composeSession({
      ...base,
      state: newLearner(),
      mode: "instrument",
      recovery: true,
    });
    expect(plan.introductions).toEqual([]);
    expect(plan.diagnostics.notes).toContain("welcome back: introduction deferred");
  });

  it("scales the budget of a longer or shorter session, never past the original", () => {
    const at = (budgetSec: number) =>
      composeSession({ ...base, state, mode: "instrument", recovery: true, budgetSec }).budgetSec;
    expect(at(1200)).toBe(600);
    expect(at(400)).toBe(200);
    expect(at(240)).toBe(RECOVERY_MIN_BUDGET_SEC);
    expect(at(120)).toBe(120);
  });

  it("is deterministic for a seed", () => {
    const run = () => composeSession({ ...base, state, mode: "instrument", recovery: true });
    expect(run()).toEqual(run());
  });

  it("does nothing in Away mode or in a practice round", () => {
    const away = composeSession({ ...base, state, mode: "away", recovery: true });
    expect(away).toEqual(composeSession({ ...base, state, mode: "away" }));
    expect(away.recovery).toBeUndefined();
    const practice = composeSession({
      ...base,
      state,
      mode: "instrument",
      practice: true,
      recovery: true,
    });
    expect(practice).toEqual(
      composeSession({ ...base, state, mode: "instrument", practice: true }),
    );
    expect(practice.recovery).toBeUndefined();
  });

  it("is the same as a normal session for a learner who has nothing new to do and nothing due", () => {
    const plain = composeSession({ ...base, state: learnerAtDailyCap(), mode: "instrument" });
    const plan = composeSession({
      ...base,
      state: learnerAtDailyCap(),
      mode: "instrument",
      recovery: true,
    });
    expect(plan.diagnostics.dueCount).toBe(plain.diagnostics.dueCount);
  });

  it("never plans a new item or an introduction, whatever the seed, budget and learner", () => {
    const learners = [newLearner(), learnerWithDueCards(), learnerAtDailyCap()];
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0x7fffffff }),
        fc.integer({ min: 60, max: 3600 }),
        fc.constantFrom(0, 1, 2),
        (seed, budgetSec, which) => {
          const plan = composeSession({
            ...base,
            seed,
            budgetSec,
            state: learners[which] ?? newLearner(),
            mode: "instrument",
            recovery: true,
          });
          expect(items(plan).some((i) => i.isNew)).toBe(false);
          expect(plan.introductions).toEqual([]);
          expect(plan.budgetSec).toBeLessThanOrEqual(budgetSec);
        },
      ),
      { numRuns: 60 },
    );
  });
});
