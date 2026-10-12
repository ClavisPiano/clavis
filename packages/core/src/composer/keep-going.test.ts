import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { LearnerState } from "../state/types.js";
import { composeSession } from "./compose.js";
import { hasNewMaterial } from "./available.js";
import { V1_GRAPH } from "./fixtures/graph.js";
import { NOW, learnerAtDailyCap, learnerWithDueCards, newLearner } from "./fixtures/learners.js";
import type { ComposeInput, PlannedItem, SessionPlan } from "./types.js";

const base = { graph: V1_GRAPH, now: NOW, tzOffsetMin: 0, seed: 42 };
const compose = (state: LearnerState, o: Partial<ComposeInput> = {}) =>
  composeSession({ ...base, state, mode: "instrument", ...o });
const blocks = (p: SessionPlan): PlannedItem[][] => [p.blocks.ear, p.blocks.read];
const items = (p: SessionPlan): PlannedItem[] => blocks(p).flat();

function expectNoImmediateRepeat(plan: SessionPlan): void {
  for (const block of blocks(plan)) {
    if (new Set(block.map((i) => i.itemId)).size < 2) continue;
    block.forEach((it, k) => {
      expect(it.itemId).not.toBe(block[k - 1]?.itemId);
    });
  }
}

describe("practice fills the time (keep going)", () => {
  it.each([60, 120, 300, 720, 1500])("reaches a %i s budget within one item", (budgetSec) => {
    const plan = compose(learnerWithDueCards(), { practice: true, budgetSec });
    const biggest = Math.max(...items(plan).map((i) => i.estimatedSec));
    const orient = plan.orient?.estimatedSec ?? 0;
    const itemSec = plan.estimatedSec - orient;
    expect(itemSec + orient).toBeLessThanOrEqual(budgetSec + biggest);
    // Whatever is left over is smaller than the largest item.
    expect(budgetSec - orient - itemSec).toBeLessThan(biggest);
  });

  it("repeats items once the single pass is used up", () => {
    const s = learnerWithDueCards();
    const once = compose(s, { practice: true, budgetSec: 60 });
    const long = compose(s, { practice: true, budgetSec: 1200 });
    const ids = items(long).map((i) => i.itemId);
    expect(items(long).length).toBeGreaterThan(items(once).length);
    expect(new Set(ids).size).toBeLessThan(ids.length);
    expect(long.introductions).toEqual([]);
    expect(items(long).every((i) => !i.isNew)).toBe(true);
  });

  it("never plays an item twice in a row when there are two or more distinct items", () => {
    expectNoImmediateRepeat(compose(learnerWithDueCards(), { practice: true, budgetSec: 1500 }));
  });

  it("with a single started item still fills the time", () => {
    const s = learnerWithDueCards();
    const [keep] = Object.keys(s.cards);
    for (const id of Object.keys(s.cards)) if (id !== keep) Reflect.deleteProperty(s.cards, id);
    const plan = compose(s, { practice: true, budgetSec: 300 });
    expect(items(plan).length).toBeGreaterThan(1);
    expect(new Set(items(plan).map((i) => i.itemId)).size).toBe(1);
  });

  it("is deterministic for a seed, and normal plans still list each item once", () => {
    const s = learnerWithDueCards();
    expect(compose(s, { practice: true, budgetSec: 900 })).toEqual(
      compose(s, { practice: true, budgetSec: 900 }),
    );
    const normal = compose(s);
    expect(new Set(items(normal).map((i) => i.itemId)).size).toBe(items(normal).length);
  });

  it("property: fills the budget, no immediate repeats, deterministic", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 30, max: 2400 }),
        fc.integer({ min: 0, max: 0x7fffffff }),
        fc.constantFrom<"instrument" | "away">("instrument", "away"),
        fc.integer({ min: 1, max: 10 }),
        (budgetSec, seed, mode, keepCount) => {
          const s = learnerWithDueCards();
          for (const id of Object.keys(s.cards).slice(keepCount)) {
            Reflect.deleteProperty(s.cards, id);
          }
          const input = { practice: true, budgetSec, seed, mode } as const;
          const plan = compose(s, input);
          expect(compose(s, input)).toEqual(plan);
          const all = items(plan);
          if (all.length === 0) return;
          const orient = plan.orient?.estimatedSec ?? 0;
          const biggest = Math.max(...all.map((i) => i.estimatedSec));
          const used = plan.estimatedSec - orient;
          // Either one item overran a tiny budget, or the leftover is under one item.
          expect(budgetSec - orient - used < biggest || all.length === 1).toBe(true);
          expectNoImmediateRepeat(plan);
          expect(plan.introductions).toEqual([]);
        },
      ),
      { numRuns: 150 },
    );
  });
});

describe("extraNewItems (learn something new)", () => {
  it("adds exactly one batch on top of what is left of the cap", () => {
    const s = learnerAtDailyCap();
    expect(compose(s).diagnostics.newAllowance).toBe(0);
    const plan = compose(s, { extraNewItems: 5 });
    expect(plan.diagnostics.newAllowance).toBe(5);
    const fresh = items(plan).filter((i) => i.isNew);
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.length).toBeLessThanOrEqual(5);
    expect(compose(learnerWithDueCards(), { extraNewItems: 4 }).diagnostics.newAllowance).toBe(9);
  });

  it("keeps the single-introduction rule", () => {
    for (const s of [newLearner(), learnerAtDailyCap(), learnerWithDueCards()]) {
      expect(compose(s, { extraNewItems: 15 }).introductions.length).toBeLessThanOrEqual(1);
    }
  });

  it("is ignored by practice, which introduces nothing", () => {
    const plan = compose(learnerWithDueCards(), { practice: true, extraNewItems: 9 });
    expect(plan.introductions).toEqual([]);
    expect(plan.diagnostics.newAllowance).toBe(0);
    expect(items(plan).every((i) => !i.isNew)).toBe(true);
  });

  it("treats zero, negative and fractional values safely", () => {
    const s = learnerAtDailyCap();
    expect(compose(s, { extraNewItems: 0 })).toEqual(compose(s));
    expect(compose(s, { extraNewItems: -3 }).diagnostics.newAllowance).toBe(0);
    expect(compose(s, { extraNewItems: 2.9 }).diagnostics.newAllowance).toBe(2);
  });

  it("property: new items never exceed the allowance and at most one node is introduced", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 15 }),
        fc.constantFrom("due", "cap", "new"),
        fc.integer({ min: 0, max: 0x7fffffff }),
        (extra, who, seed) => {
          const s =
            who === "due"
              ? learnerWithDueCards()
              : who === "cap"
                ? learnerAtDailyCap()
                : newLearner();
          const plan = compose(s, { extraNewItems: extra, seed });
          expect(items(plan).filter((i) => i.isNew).length).toBeLessThanOrEqual(
            plan.diagnostics.newAllowance,
          );
          expect(plan.introductions.length).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("hasNewMaterial", () => {
  const args = { graph: V1_GRAPH, now: NOW, tzOffsetMin: 0, mode: "instrument" } as const;

  it("is true at the daily cap when learning nodes still have fresh items", () => {
    expect(hasNewMaterial({ ...args, state: learnerAtDailyCap(), batch: 5 })).toBe(true);
  });

  it("is true for a learner who can be introduced to something", () => {
    expect(hasNewMaterial({ ...args, state: newLearner(), batch: 5 })).toBe(true);
  });

  it("is false when no generator is available", () => {
    expect(hasNewMaterial({ ...args, state: learnerAtDailyCap(), batch: 5, generators: {} })).toBe(
      false,
    );
  });

  it("agrees with the Learn session plan", () => {
    for (const state of [learnerAtDailyCap(), learnerWithDueCards(), newLearner()]) {
      const plan = compose(state, { extraNewItems: 5 });
      expect(hasNewMaterial({ ...args, state, batch: 5 })).toBe(items(plan).some((i) => i.isNew));
    }
  });
});
