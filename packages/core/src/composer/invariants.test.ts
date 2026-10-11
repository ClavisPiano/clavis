import { at } from "../theory/util.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { GeneratorId, NodeState, SkillGraph } from "../graph/schema.js";
import { isNodeEnabled } from "../graph/validate.js";
import { itemId } from "../items/ids.js";
import { GENERATORS } from "../items/registry.js";
import { learnerDay } from "../learning/day.js";
import { newItemAllowance } from "../scheduler/new-items.js";
import { initialState } from "../state/reduce.js";
import type { LearnerState } from "../state/types.js";
import { composeSession, dependsOnHands } from "./compose.js";
import { withHandsDependentEar } from "./fixtures/graph.js";
import { CTX } from "./fixtures/learners.js";
import { typeKey } from "./interleave.js";
import type { PlannedItem } from "./types.js";

const DAY = 86_400_000;
const GRAPHS = [withHandsDependentEar(true), withHandsDependentEar(false)];

const STATES: NodeState[] = ["locked", "available", "learning", "fluent", "mastered"];

interface Scenario {
  graph: SkillGraph;
  state: LearnerState;
  mode: "instrument" | "away";
  budgetSec: number;
  seed: number;
  now: number;
  tz: number;
}

const scenarioArb: fc.Arbitrary<Scenario> = fc
  .record({
    singAway: fc.boolean(),
    nodeStates: fc.array(
      fc.constantFrom<NodeState>(...STATES, "learning", "available", "mastered"),
      { minLength: 40, maxLength: 40 },
    ),
    // Per node: probability-ish selectors for which items have cards, and how due they are.
    cardBits: fc.array(fc.integer({ min: 0, max: 0xffff }), { minLength: 40, maxLength: 40 }),
    dueDays: fc.array(fc.integer({ min: -40, max: 6 }), { minLength: 16, maxLength: 16 }),
    stability: fc.array(fc.double({ min: 0.3, max: 80, noNaN: true }), {
      minLength: 16,
      maxLength: 16,
    }),
    newToday: fc.integer({ min: 0, max: 7 }),
    history: fc.constantFrom("none", "yesterday", "today", "old"),
    durations: fc.constantFrom("seed", "fast", "slow"),
    mode: fc.constantFrom<"instrument" | "away">("instrument", "away"),
    budgetSec: fc.integer({ min: 30, max: 1500 }),
    useSettingsBudget: fc.boolean(),
    seed: fc.integer({ min: 0, max: 0x7fffffff }),
    tz: fc.integer({ min: -720, max: 840 }),
    dayOffset: fc.integer({ min: 0, max: 30 }),
  })
  .map((r) => {
    const graph = at(GRAPHS, r.singAway ? 0 : 1);
    const tz = r.tz;
    const now = Date.UTC(2026, 2, 10, 10, 0, 0) - tz * 60_000 + r.dayOffset * DAY;
    const today = learnerDay(now, tz);
    const state = initialState({ graph, scheduler: CTX.scheduler });
    graph.nodes.forEach((n, i) => {
      const rec = state.nodes[n.id] ?? { state: "locked" as NodeState };
      rec.state = at(r.nodeStates, i % r.nodeStates.length);
      state.nodes[n.id] = rec;
      if (rec.state === "locked" || rec.state === "available") return;
      const gen = GENERATORS[at(n.itemGenerators, 0)];
      if (!gen) return;
      const items = gen.listItems(n).slice(0, 16);
      const bits = at(r.cardBits, i % r.cardBits.length);
      items.forEach((params, j) => {
        if (((bits >> (j % 16)) & 1) === 0) return;
        const id = itemId(n.id, params);
        const k = (i + j) % 16;
        state.cards[id] = {
          nodeId: n.id,
          lastAttemptAt: now - 5 * DAY,
          reps: 3,
          card: {
            due: now + at(r.dueDays, k) * DAY,
            stability: at(r.stability, k),
            difficulty: 5,
            elapsedDays: 1,
            scheduledDays: 1,
            reps: 3,
            lapses: 0,
            state: "review",
          },
        };
      });
    });
    state.daily[today] = {
      newItems: r.newToday,
      nodesIntroduced: 0,
      sessions: 0,
      practiceSec: 0,
      mode: { instrument: 0, away: 0 },
    };
    const prev = learnerDay(now - DAY, tz);
    if (r.history === "yesterday")
      state.keyOfDayHistory.push({ day: prev, key: { tonic: "G", mode: "major" } });
    if (r.history === "today")
      state.keyOfDayHistory.push({ day: today, key: { tonic: "Bb", mode: "major" } });
    if (r.history === "old")
      state.keyOfDayHistory.push({
        day: learnerDay(now - 9 * DAY, tz),
        key: { tonic: "F", mode: "major" },
      });
    if (r.durations !== "seed") {
      const secs = r.durations === "fast" ? 2 : 25;
      for (const g of Object.keys(GENERATORS) as GeneratorId[])
        state.durations[g] = [secs, secs, secs, secs];
    }
    if (r.useSettingsBudget) state.settings.budgetSec = Math.max(60, r.budgetSec);
    return { graph, state, mode: r.mode, budgetSec: r.budgetSec, seed: r.seed, now, tz };
  });

const compose = (s: Scenario, o: { now?: number; seed?: number; explicit?: boolean } = {}) =>
  composeSession({
    state: s.state,
    graph: s.graph,
    now: o.now ?? s.now,
    tzOffsetMin: s.tz,
    mode: s.mode,
    ...(o.explicit === false ? {} : { budgetSec: s.budgetSec }),
    seed: o.seed ?? s.seed,
  });

const NUM_RUNS = 400;
const all = (p: { blocks: { ear: PlannedItem[]; read: PlannedItem[] } }) => [
  ...p.blocks.ear,
  ...p.blocks.read,
];

describe("composeSession invariants", () => {
  it("respects the budget to within one item and reports the sum", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const plan = compose(s);
        const items = all(plan);
        const sum =
          items.reduce((a, i) => a + i.estimatedSec, 0) + (plan.orient?.estimatedSec ?? 0);
        expect(plan.estimatedSec).toBeCloseTo(sum, 9);
        const biggest = Math.max(0, ...items.map((i) => i.estimatedSec));
        expect(plan.estimatedSec).toBeLessThanOrEqual(plan.budgetSec + biggest);
        expect(plan.budgetSec).toBe(s.budgetSec);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("keeps new items within the daily allowance and introduces at most one node", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const plan = compose(s);
        const today = learnerDay(s.now, s.tz);
        const allowance = newItemAllowance({
          introducedToday: s.state.daily[today]?.newItems ?? 0,
        });
        expect(plan.diagnostics.newAllowance).toBe(allowance);
        const news = all(plan).filter((i) => i.isNew);
        expect(news.length).toBeLessThanOrEqual(allowance);
        for (const i of news) expect(s.state.cards[i.itemId]).toBeUndefined();
        expect(plan.introductions.length).toBeLessThanOrEqual(1);
        const [intro] = plan.introductions;
        if (intro !== undefined) {
          expect(s.state.nodes[intro]?.state).toBe("available");
          expect(news.some((i) => i.nodeId === intro)).toBe(true);
        }
        // Every planned item is unique, due items really are due, generators belong to the node.
        expect(new Set(all(plan).map((i) => i.itemId)).size).toBe(all(plan).length);
        for (const i of all(plan)) {
          const node = at(
            s.graph.nodes.filter((n) => n.id === i.nodeId),
            0,
          );
          expect(node.itemGenerators).toContain(i.generator);
          expect(itemId(i.nodeId, i.params)).toBe(i.itemId);
          if (!i.isNew) expect(s.state.cards[i.itemId]?.card.due).toBeLessThanOrEqual(s.now);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("only introduces when no EAR node is already learning", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const plan = compose(s);
        if (plan.introductions.length === 0) return;
        const learning = s.graph.nodes.filter(
          (n) =>
            n.strand === "EAR" &&
            isNodeEnabled(n, s.graph.generators) &&
            s.state.nodes[n.id]?.state === "learning",
        );
        expect(learning).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("leaves no avoidable adjacent duplicates", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const plan = compose(s);
        for (const block of [plan.blocks.ear, plan.blocks.read]) {
          const counts = new Map<string, number>();
          for (const i of block) counts.set(typeKey(i), (counts.get(typeKey(i)) ?? 0) + 1);
          const max = Math.max(0, ...counts.values());
          if (max > Math.ceil(block.length / 2)) continue; // adjacency unavoidable
          for (let i = 1; i < block.length; i++) {
            expect(typeKey(at(block, i))).not.toBe(typeKey(at(block, i - 1)));
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("keeps Away plans to eligible generators and never introduces HANDS-dependent nodes", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const plan = compose({ ...s, mode: "away" });
        expect(plan.orient).toBeNull();
        expect(plan.blocks.read).toEqual([]);
        expect(plan.blocks.apply).toBeNull();
        for (const i of plan.blocks.ear) {
          const info = s.graph.generators.find((g) => g.id === i.generator);
          expect(info?.awayEligible).toBe(true);
          expect(info?.implemented).toBe(true);
          expect(s.graph.nodes.find((n) => n.id === i.nodeId)?.strand).toBe("EAR");
        }
        for (const id of plan.introductions) expect(dependsOnHands(s.graph, id)).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("is deterministic for the same input", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const before = JSON.stringify(s.state);
        const a = compose(s);
        expect(compose(s)).toEqual(a);
        expect(JSON.stringify(s.state)).toBe(before); // input is not mutated
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("keeps the key of the day stable within a learner day, whatever the seed or time", () => {
    fc.assert(
      fc.property(scenarioArb, fc.integer({ min: 0, max: 0x7fffffff }), (s, otherSeed) => {
        const a = compose(s);
        const b = compose(s, { now: s.now + 3 * 3_600_000, seed: otherSeed });
        expect(learnerDay(s.now + 3 * 3_600_000, s.tz)).toBe(learnerDay(s.now, s.tz));
        expect(b.key).toEqual(a.key);
        const today = learnerDay(s.now, s.tz);
        const logged = s.state.keyOfDayHistory.find((k) => k.day === today);
        if (logged) expect(a.key).toEqual(logged.key);
        // Once the day's session is logged the same key comes back.
        const withToday: LearnerState = {
          ...s.state,
          keyOfDayHistory: [
            ...s.state.keyOfDayHistory.filter((k) => k.day !== today),
            { day: today, key: a.key },
          ],
        };
        expect(compose({ ...s, state: withToday }).key).toEqual(a.key);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
