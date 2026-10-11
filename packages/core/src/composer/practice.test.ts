import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { CardState } from "../scheduler/card.js";
import type { LearnerState } from "../state/types.js";
import { composeSession } from "./compose.js";
import { V1_GRAPH } from "./fixtures/graph.js";
import { NOW, learnerAtDailyCap, learnerWithDueCards, newLearner } from "./fixtures/learners.js";
import { rankWeakest } from "./practice.js";
import type { ComposeInput, PlannedItem, SessionPlan } from "./types.js";

const DAY = 86_400_000;
const base = { graph: V1_GRAPH, now: NOW, tzOffsetMin: 0, seed: 42 };
const items = (p: SessionPlan): PlannedItem[] => [...p.blocks.ear, ...p.blocks.read];

const compose = (state: LearnerState, o: Partial<ComposeInput> = {}) =>
  composeSession({ ...base, state, mode: "instrument", ...o });

const card = (o: Partial<CardState>): CardState => ({
  due: NOW + DAY,
  stability: 5,
  difficulty: 5,
  elapsedDays: 1,
  scheduledDays: 5,
  reps: 3,
  lapses: 0,
  state: "review",
  lastReview: NOW - 2 * DAY,
  ...o,
});

describe("rankWeakest", () => {
  it("orders by lowest retrievability regardless of due date", () => {
    const strong = { itemId: "a", card: card({ stability: 60, due: NOW - 10 * DAY }) };
    const weak = { itemId: "b", card: card({ stability: 1, due: NOW + 30 * DAY }) };
    const mid = { itemId: "c", card: card({ stability: 8 }) };
    expect(rankWeakest([strong, mid, weak], NOW).map((x) => x.itemId)).toEqual(["b", "c", "a"]);
  });

  it("breaks ties by least recently reviewed, then item id", () => {
    const older = { itemId: "z", card: card({ lastReview: NOW - 2 * DAY }) };
    const newer = { itemId: "y", card: card({ lastReview: NOW - 2 * DAY + 1 }) };
    const sameA = { itemId: "a", card: card({ lastReview: NOW - 2 * DAY }) };
    // Equal retrievability needs equal elapsed time, so use identical lastReview for the id tie.
    expect(rankWeakest([sameA, older], NOW).map((x) => x.itemId)).toEqual(["a", "z"]);
    expect(rankWeakest([newer, older], NOW)).toHaveLength(2);
  });
});

describe("composeSession practice (T2.15)", () => {
  it("fills a practice session from started items even when nothing is due", () => {
    const s = learnerWithDueCards();
    // Push every card into the future: a normal session has nothing due.
    for (const rec of Object.values(s.cards)) rec.card.due = NOW + 30 * DAY;
    expect(items(compose(s)).filter((i) => !i.isNew)).toEqual([]);
    const plan = compose(s, { practice: true });
    expect(plan.practice).toBe(true);
    expect(plan.introductions).toEqual([]);
    expect(plan.diagnostics.newAllowance).toBe(0);
    expect(items(plan).length).toBeGreaterThan(0);
    for (const i of items(plan)) {
      expect(i.isNew).toBe(false);
      expect(s.cards[i.itemId]).toBeDefined();
    }
  });

  it("is empty for a learner with no cards, and introduces nothing", () => {
    const plan = compose(newLearner(), { practice: true });
    expect(items(plan)).toEqual([]);
    expect(plan.introductions).toEqual([]);
  });

  it("does not mark ordinary plans as practice", () => {
    expect("practice" in compose(learnerWithDueCards())).toBe(false);
  });

  it("takes the weakest item first when the budget only fits one", () => {
    const s = learnerWithDueCards();
    const ids = Object.keys(s.cards);
    const weakId = ids[ids.length - 1] ?? "";
    for (const id of ids) {
      const rec = s.cards[id];
      if (rec) rec.card = card({ stability: id === weakId ? 0.5 : 40 });
    }
    const plan = compose(s, { practice: true, budgetSec: 40 });
    expect(items(plan).map((i) => i.itemId)).toContain(weakId);
  });

  it("does not change the state it is given", () => {
    const s = learnerWithDueCards();
    const before = JSON.stringify(s);
    compose(s, { practice: true });
    expect(JSON.stringify(s)).toBe(before);
  });

  it("is deterministic for a seed", () => {
    const s = learnerWithDueCards();
    expect(compose(s, { practice: true })).toEqual(compose(s, { practice: true }));
  });

  it("respects Away eligibility", () => {
    const plan = compose(learnerWithDueCards(), { practice: true, mode: "away" });
    for (const i of items(plan)) {
      expect(V1_GRAPH.generators.find((g) => g.id === i.generator)?.awayEligible).toBe(true);
    }
    expect(plan.orient).toBeNull();
  });

  it("ignores the daily cap, so it works at the cap", () => {
    const plan = compose(learnerAtDailyCap(), { practice: true });
    expect(items(plan).length).toBeGreaterThan(0);
    expect(items(plan).every((i) => !i.isNew)).toBe(true);
  });
});

describe("composeSession newItemsPerDay setting", () => {
  it("defaults to 5 and follows the setting", () => {
    const s = learnerWithDueCards();
    expect(compose(s).diagnostics.newAllowance).toBe(5);
    s.settings.newItemsPerDay = 3;
    expect(compose(s).diagnostics.newAllowance).toBe(3);
    s.settings.newItemsPerDay = 12;
    expect(compose(s).diagnostics.newAllowance).toBe(12);
  });

  it("subtracts what was introduced today from the configured cap", () => {
    const s = learnerAtDailyCap();
    expect(compose(s).diagnostics.newAllowance).toBe(0);
    s.settings.newItemsPerDay = 8;
    const plan = compose(s);
    expect(plan.diagnostics.newAllowance).toBe(3);
    expect(items(plan).filter((i) => i.isNew).length).toBeLessThanOrEqual(3);
  });
});

describe("composeSession practice properties", () => {
  const scenario = fc.record({
    dueDays: fc.array(fc.integer({ min: -30, max: 60 }), { minLength: 8, maxLength: 8 }),
    stability: fc.array(fc.double({ min: 0.3, max: 90, noNaN: true }), {
      minLength: 8,
      maxLength: 8,
    }),
    mode: fc.constantFrom<"instrument" | "away">("instrument", "away"),
    budgetSec: fc.integer({ min: 30, max: 1500 }),
    seed: fc.integer({ min: 0, max: 0x7fffffff }),
    learner: fc.constantFrom("due", "cap", "new"),
    cap: fc.option(fc.integer({ min: 3, max: 15 }), { nil: undefined }),
  });

  it("has no new items or introductions, only carded items, and respects the budget", () => {
    fc.assert(
      fc.property(scenario, (r) => {
        const s =
          r.learner === "due"
            ? learnerWithDueCards()
            : r.learner === "cap"
              ? learnerAtDailyCap()
              : newLearner();
        Object.values(s.cards).forEach((rec, i) => {
          rec.card.due = NOW + (r.dueDays[i % 8] ?? 0) * DAY;
          rec.card.stability = r.stability[i % 8] ?? 1;
        });
        if (r.cap !== undefined) s.settings.newItemsPerDay = r.cap;
        const plan = compose(s, {
          mode: r.mode,
          budgetSec: r.budgetSec,
          seed: r.seed,
          practice: true,
        });
        const picked = items(plan);
        expect(plan.practice).toBe(true);
        expect(plan.introductions).toEqual([]);
        expect(plan.diagnostics.newAllowance).toBe(0);
        for (const i of picked) {
          expect(i.isNew).toBe(false);
          expect(s.cards[i.itemId]?.nodeId).toBe(i.nodeId);
        }
        expect(new Set(picked.map((i) => i.itemId)).size).toBe(picked.length);
        const biggest = Math.max(0, ...picked.map((i) => i.estimatedSec));
        expect(plan.estimatedSec).toBeLessThanOrEqual(plan.budgetSec + biggest);
        if (r.learner === "new") expect(picked).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });
});
