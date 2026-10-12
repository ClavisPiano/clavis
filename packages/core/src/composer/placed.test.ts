import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { LearningEvent } from "../events/schema.js";
import { itemId } from "../items/ids.js";
import { learnerDay } from "../learning/day.js";
import { newItemAllowance } from "../scheduler/new-items.js";
import { Builder, DAY_MS } from "../state/test-helpers.js";
import type { LearnerState } from "../state/types.js";
import { hasNewMaterial } from "./available.js";
import { composeSession } from "./compose.js";
import { V1_GRAPH } from "./fixtures/graph.js";
import { D135, DIATONIC, NOW, fold } from "./fixtures/learners.js";
import type { ComposeInput, PlannedItem, SessionPlan } from "./types.js";

/* Skills placed above `learning` (R19) write no cards but must still feed sessions. */

const RHYTHM = "ear.rhythm.echo";
const base = { graph: V1_GRAPH, now: NOW, tzOffsetMin: 0, seed: 42 };
const compose = (state: LearnerState, o: Partial<ComposeInput> = {}) =>
  composeSession({ ...base, state, mode: "instrument", ...o });
const all = (p: SessionPlan): PlannedItem[] => [...p.blocks.ear, ...p.blocks.read];
const news = (p: SessionPlan) => all(p).filter((i) => i.isNew);
const nodesOf = (items: PlannedItem[]) => [...new Set(items.map((i) => i.nodeId))];
const count = (items: PlannedItem[], nodeId: string) =>
  items.filter((i) => i.nodeId === nodeId).length;

const rhythmItem = (n: number) => itemId(RHYTHM, { pattern: `r0${String(n)}` });

/** Placement 135 fluent, then rhythm echo introduced with its first five items, a day before NOW. */
function ownerHistory(): LearningEvent[] {
  const b = new Builder();
  const t0 = NOW - DAY_MS;
  const sid = b.sessionId(1);
  const out: LearningEvent[] = [
    b.place(t0, { [D135]: "fluent", "read.bass.landmarks": "available" }),
    b.start(t0 + 1000, sid, { budgetSec: 720 }),
    b.introduce(t0 + 2000, sid, RHYTHM),
  ];
  let t = t0 + 3000;
  for (let n = 1; n <= 5; n++) {
    out.push(
      ...b.item(t, sid, RHYTHM, rhythmItem(n), {
        latencyMs: 5000,
        isNew: true,
        generator: "cellEcho",
      }),
    );
    t += 8000;
  }
  out.push(b.end(t, sid));
  return out;
}

describe("placed skills feed new items", () => {
  it("replays the owner's log: with room, the next plan includes 135 items", () => {
    const state = fold(ownerHistory());
    expect(state.nodes[D135]?.state).toBe("fluent");
    expect(state.nodes[RHYTHM]?.state).toBe("learning");
    expect(Object.keys(state.cards).some((id) => id.startsWith(D135))).toBe(false);
    // Rhythm echo has a long item list; 135 follows once the allowance outlasts the fresh ones.
    const plan = compose(state, { now: NOW + DAY_MS, extraNewItems: 40 });
    expect(count(news(plan), D135)).toBe(3);
    expect(hasNewMaterial({ ...base, state, mode: "instrument", batch: 5 })).toBe(true);
  });

  it("alternates learning and placed items, learning first, when the allowance is tight", () => {
    const state = fold(ownerHistory());
    const tight = news(compose(state, { now: NOW + DAY_MS }));
    expect(tight.length).toBe(5);
    // One item each per round, learning first: rhythm, 135, rhythm, 135, rhythm.
    expect(count(tight, RHYTHM)).toBe(3);
    expect(count(tight, D135)).toBe(2);
    // A larger allowance takes the rest of 135 and more rhythm.
    const roomy = news(compose(state, { now: NOW + DAY_MS, extraNewItems: 40 }));
    expect(count(roomy, RHYTHM)).toBeGreaterThan(5);
    expect(count(roomy, D135)).toBe(3);
  });

  it("gives a placed-fluent learner with nothing else an introduction and 135 behind it", () => {
    const b = new Builder();
    const state = fold([b.place(NOW - DAY_MS, { [D135]: "fluent" })]);
    const plan = compose(state, { extraNewItems: 40 });
    expect(plan.introductions).toEqual([RHYTHM]);
    expect(count(news(plan), D135)).toBe(3);
    const tight = compose(state);
    expect(count(news(tight), RHYTHM)).toBe(3);
    expect(count(news(tight), D135)).toBe(2);
  });

  it("offers mastered nodes' items only when nothing else can supply new material", () => {
    const b = new Builder();
    const everything = Object.fromEntries(V1_GRAPH.nodes.map((n) => [n.id, "mastered" as const]));
    const placedOut = fold([b.place(NOW - DAY_MS, everything)]);
    expect(news(compose(placedOut)).length).toBeGreaterThan(0);
    expect(hasNewMaterial({ ...base, state: placedOut, mode: "instrument", batch: 5 })).toBe(true);

    // A node that could be introduced comes first: the mastered items wait.
    const withIntro = fold([b.place(NOW - DAY_MS, { [D135]: "mastered" })]);
    const p2 = compose(withIntro);
    expect(p2.introductions.length).toBe(1);
    expect(count(news(p2), D135)).toBe(0);

    // A learning node with fresh items does too.
    const sid = b.sessionId(3);
    const learning = fold([
      b.place(NOW - DAY_MS, { [D135]: "mastered" }),
      b.start(NOW - 1000, sid),
      b.introduce(NOW - 900, sid, DIATONIC),
    ]);
    const p3 = compose(learning);
    expect(news(p3).length).toBeGreaterThan(0);
    expect(count(news(p3), D135)).toBe(0);
  });

  it("leaves practice mode on carded items only", () => {
    const state = fold(ownerHistory());
    const plan = compose(state, { practice: true });
    expect(news(plan)).toEqual([]);
    expect(nodesOf(all(plan))).toEqual([RHYTHM]);
  });

  it("never offers more new items than the allowance", () => {
    const arb = fc.record({
      placed: fc.constantFrom<"fluent" | "mastered" | "available">(
        "fluent",
        "mastered",
        "available",
      ),
      extra: fc.integer({ min: 0, max: 12 }),
      cap: fc.integer({ min: 1, max: 10 }),
      withHistory: fc.boolean(),
      practice: fc.boolean(),
    });
    fc.assert(
      fc.property(arb, (h) => {
        const b = new Builder();
        const events = h.withHistory
          ? ownerHistory()
          : [b.place(NOW - DAY_MS, { [D135]: h.placed })];
        const state = fold([...events, b.settings(NOW - 5000, { newItemsPerDay: h.cap })]);
        const plan = compose(state, { extraNewItems: h.extra, practice: h.practice });
        const allowance = h.practice
          ? 0
          : newItemAllowance({
              introducedToday: state.daily[learnerDay(NOW, 0)]?.newItems ?? 0,
              cap: h.cap,
            }) + h.extra;
        expect(news(plan).length).toBeLessThanOrEqual(allowance);
      }),
      { numRuns: 80 },
    );
  });
});
