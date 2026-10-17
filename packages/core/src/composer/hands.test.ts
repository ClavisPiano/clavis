import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { itemId } from "../items/ids.js";
import { GENERATORS } from "../items/registry.js";
import type { LearnerState } from "../state/types.js";
import { composeSession, HANDS_NEW_ITEMS_PER_SESSION } from "./compose.js";
import { D135, DIATONIC, NOW } from "./fixtures/learners.js";
import { LANDMARKS, READ_GRAPH, STUB_READ_GENERATORS, readLearner } from "./fixtures/read.js";
import type { PlannedItem, SessionPlan } from "./types.js";

/*
 * HANDS (T5.3): left-hand chord items join the Apply block, but only when the session's input can
 * capture chords (MIDI). Everything else, including Away, practice and a short budget, never
 * gets them.
 */

const HANDS = "hands.lh.triads.root";
const DAY = 86_400_000;
const generators = { ...GENERATORS, ...STUB_READ_GENERATORS };
const base = { graph: READ_GRAPH, now: NOW, tzOffsetMin: 0, seed: 42, generators };

const compose = (
  state: LearnerState,
  o: {
    polyphonic?: boolean;
    mode?: "instrument" | "away";
    budgetSec?: number;
    practice?: boolean;
    seed?: number;
  } = {},
): SessionPlan =>
  composeSession({
    ...base,
    state,
    mode: o.mode ?? "instrument",
    ...(o.polyphonic === undefined ? {} : { polyphonic: o.polyphonic }),
    ...(o.budgetSec ? { budgetSec: o.budgetSec } : {}),
    ...(o.practice ? { practice: true } : {}),
    ...(o.seed === undefined ? {} : { seed: o.seed }),
  });

const allItems = (p: SessionPlan): PlannedItem[] => [
  ...p.blocks.ear,
  ...p.blocks.read,
  ...(p.blocks.apply ?? []),
];
const handsItems = (p: SessionPlan): PlannedItem[] => allItems(p).filter((i) => i.nodeId === HANDS);

/** Chord skill learning, with a card due, and nothing else started. */
function learningHands(cards: { fam: "A" | "B" | "C"; prog: string[]; dueInDays: number }[] = []) {
  return readLearner({
    nodes: {
      [D135]: "mastered",
      [HANDS]: { state: "learning", byFamily: { A: "learning" }, introducedAt: NOW - 3 * DAY },
    },
    cards: cards.map(({ fam, prog, dueInDays }) => ({
      nodeId: HANDS,
      params: { fam, prog },
      dueInDays,
    })),
  });
}

/** Everything else is mid-learning, so a HANDS introduction is the only one on offer. */
function handsAvailable() {
  return readLearner({
    nodes: {
      [D135]: "mastered",
      [DIATONIC]: { state: "learning", introducedAt: NOW - 6 * DAY },
      [LANDMARKS]: {
        state: "learning",
        byFamily: { A: "learning" },
        introducedAt: NOW - 4 * DAY,
      },
      [HANDS]: "available",
    },
  });
}

describe("HANDS in the Apply block", () => {
  it("is absent without polyphonic input: mic, tap and plain sessions never see it", () => {
    for (const state of [learningHands(), handsAvailable()]) {
      for (const polyphonic of [undefined, false]) {
        const plan = compose(state, polyphonic === undefined ? {} : { polyphonic });
        expect(handsItems(plan)).toEqual([]);
        expect(plan.introductions).not.toContain(HANDS);
      }
    }
  });

  it("is absent in Away mode even with polyphonic input", () => {
    for (const state of [learningHands(), handsAvailable()]) {
      const plan = compose(state, { mode: "away", polyphonic: true });
      expect(handsItems(plan)).toEqual([]);
      expect(plan.blocks.apply).toBeNull();
      expect(plan.introductions).not.toContain(HANDS);
    }
  });

  it("is absent from practice rounds and under time pressure", () => {
    const state = learningHands([{ fam: "A", prog: ["I", "IV", "V", "I"], dueInDays: -1 }]);
    expect(handsItems(compose(state, { polyphonic: true, practice: true }))).toEqual([]);
    expect(handsItems(compose(state, { polyphonic: true, budgetSec: 240 }))).toEqual([]);
  });

  it("offers new chord items in the Apply block with polyphonic input, in C major while reading is new", () => {
    const plan = compose(learningHands(), { polyphonic: true });
    const items = handsItems(plan);
    expect(items).toHaveLength(HANDS_NEW_ITEMS_PER_SESSION);
    expect(plan.blocks.apply).toEqual(items);
    for (const item of items) {
      expect(item.generator).toBe("lhPattern");
      expect(item.isNew).toBe(true);
      expect(item.fam).toBe("A");
      expect(item.key).toEqual({ tonic: "C", mode: "major" });
      expect(item.itemId).toBe(itemId(HANDS, item.params));
    }
    expect(new Set(items.map((i) => i.itemId)).size).toBe(items.length);
  });

  it("puts a due chord item first, with its stored params, ahead of new ones", () => {
    const params = { fam: "A" as const, prog: ["I", "vi", "IV", "V"] };
    const plan = compose(learningHands([{ ...params, dueInDays: -2 }]), { polyphonic: true });
    const apply = plan.blocks.apply ?? [];
    expect(apply[0]).toMatchObject({ nodeId: HANDS, isNew: false, params });
    expect(apply.slice(1).every((i) => i.isNew)).toBe(true);
  });

  it("does not offer a due chord item without polyphonic input", () => {
    const state = learningHands([{ fam: "A", prog: ["I", "IV", "V", "I"], dueInDays: -2 }]);
    expect(compose(state).blocks.apply).toBeNull();
  });

  it("introduces the HANDS skill only with polyphonic input", () => {
    const state = handsAvailable();
    const withMidi = compose(state, { polyphonic: true });
    expect(withMidi.introductions).toEqual([HANDS]);
    expect(withMidi.introductionKeyFamilies).toEqual({ [HANDS]: "A" });
    expect(handsItems(withMidi).length).toBeGreaterThan(0);
    expect(withMidi.blocks.apply?.[0]?.nodeId).toBe(HANDS);

    const without = compose(state);
    expect(without.introductions).toEqual([]);
    expect(handsItems(without)).toEqual([]);
  });

  it("makes the same plan with or without the flag when HANDS is not in play", () => {
    const state = readLearner({
      nodes: {
        [D135]: { state: "learning", introducedAt: NOW - 3 * DAY },
        [LANDMARKS]: "locked",
      },
    });
    expect(compose(state, { polyphonic: true })).toEqual(compose(state));
  });

  it("never offers HANDS items unless polyphonic, whatever the seed, mode or budget", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000 }),
        fc.constantFrom<"instrument" | "away">("instrument", "away"),
        fc.integer({ min: 120, max: 1800 }),
        fc.boolean(),
        (seed, mode, budgetSec, practice) => {
          for (const state of [learningHands(), handsAvailable()]) {
            const plan = compose(state, { seed, mode, budgetSec, practice });
            expect(handsItems(plan)).toEqual([]);
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it("keeps the plan within its budget and the new-item cap with HANDS in it", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 301, max: 1800 }),
        (seed, budgetSec) => {
          const plan = compose(handsAvailable(), { polyphonic: true, seed, budgetSec });
          const fresh = allItems(plan).filter((i) => i.isNew).length;
          expect(fresh).toBeLessThanOrEqual(plan.diagnostics.newAllowance);
          expect(plan.blocks.apply?.length ?? 0).toBeGreaterThan(0);
        },
      ),
      { numRuns: 50 },
    );
  });
});
