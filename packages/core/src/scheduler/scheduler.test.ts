import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { learnerDay } from "../learning/day.js";
import type { Rating } from "../learning/rating.js";
import { fromFsrsCard, toFsrsCard, type CardState } from "./card.js";
import { countIntroducedOnDay, newItemAllowance } from "./new-items.js";
import { overdueness, rankDue } from "./rank.js";
import { createScheduler } from "./scheduler.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1, 12);
const s = createScheduler();

function lastOf<T>(xs: T[]): T {
  return at(xs, xs.length - 1);
}
function at<T>(xs: T[], i: number): T {
  const v = xs[i];
  if (v === undefined) throw new Error("index out of range");
  return v;
}
function reviewedAt(c: CardState): number {
  if (c.lastReview === undefined) throw new Error("never reviewed");
  return c.lastReview;
}

function replay(history: [Rating, number][]): CardState[] {
  let card = s.newCard(T0);
  const out = [card];
  for (const [r, at] of history) {
    card = s.review(card, r, at);
    out.push(card);
  }
  return out;
}

const history: [Rating, number][] = [
  ["good", T0],
  ["good", T0 + 10 * 60_000],
  ["good", T0 + 2 * DAY],
  ["again", T0 + 9 * DAY],
  ["good", T0 + 9 * DAY + 10 * 60_000],
];

describe("scheduler", () => {
  it("golden history is stable and replay-identical", () => {
    const a = replay(history);
    const b = replay(history);
    expect(a).toEqual(b);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
    const summary = a.map((c) => ({
      state: c.state,
      reps: c.reps,
      lapses: c.lapses,
      stability: Number(c.stability.toFixed(4)),
      dueMin: (c.due - T0) / 60_000,
    }));
    expect(summary).toMatchInlineSnapshot(`
      [
        {
          "dueMin": 0,
          "lapses": 0,
          "reps": 0,
          "stability": 0,
          "state": "new",
        },
        {
          "dueMin": 10,
          "lapses": 0,
          "reps": 1,
          "stability": 2.3065,
          "state": "learning",
        },
        {
          "dueMin": 2890,
          "lapses": 0,
          "reps": 2,
          "stability": 2.3065,
          "state": "review",
        },
        {
          "dueMin": 18720,
          "lapses": 0,
          "reps": 3,
          "stability": 10.971,
          "state": "review",
        },
        {
          "dueMin": 12970,
          "lapses": 1,
          "reps": 4,
          "stability": 1.4696,
          "state": "relearning",
        },
        {
          "dueMin": 15850,
          "lapses": 1,
          "reps": 5,
          "stability": 1.5055,
          "state": "review",
        },
      ]
    `);
  });

  it("again lowers stability and counts a lapse on a review card", () => {
    const review = lastOf(replay(history.slice(0, 3)));
    expect(review.state).toBe("review");
    const after = s.review(review, "again", review.due);
    expect(after.lapses).toBe(review.lapses + 1);
    expect(after.stability).toBeLessThan(review.stability);
  });

  it("easy > good > hard intervals", () => {
    const review = lastOf(replay(history.slice(0, 3)));
    const at = review.due;
    const iv = (r: Rating) => s.review(review, r, at).due - at;
    expect(iv("easy")).toBeGreaterThan(iv("good"));
    expect(iv("good")).toBeGreaterThan(iv("hard"));
  });

  it("round-trips through ts-fsrs cards", () => {
    for (const c of replay(history)) {
      expect(fromFsrsCard(toFsrsCard(c))).toEqual({ learningSteps: 0, ...c });
    }
  });

  it("retrievability is 0..1 and decays; isDue follows due", () => {
    const c = lastOf(replay(history.slice(0, 3)));
    const r1 = s.retrievability(c, reviewedAt(c) + DAY);
    const r2 = s.retrievability(c, reviewedAt(c) + 30 * DAY);
    expect(r1).toBeLessThanOrEqual(1);
    expect(r2).toBeGreaterThanOrEqual(0);
    expect(r2).toBeLessThan(r1);
    expect(s.isDue(c, c.due - 1)).toBe(false);
    expect(s.isDue(c, c.due)).toBe(true);
  });

  it("maximum interval limits growth", () => {
    // ts-fsrs keeps good > hard by at least a day, so the cap can be exceeded by one.
    const run = (sched: ReturnType<typeof createScheduler>) => {
      let c = sched.newCard(T0);
      for (let i = 0; i < 8; i++) c = sched.review(c, "good", c.due);
      return c.scheduledDays;
    };
    const capped = run(createScheduler({ maximumIntervalDays: 3 }));
    expect(capped).toBeLessThanOrEqual(4);
    expect(capped).toBeLessThan(run(s));
  });
});

describe("rankDue", () => {
  const mk = (id: string, due: number, stability: number) => ({
    itemId: id,
    card: { ...s.newCard(T0), due, stability, state: "review" as const },
  });
  const now = T0 + 10 * DAY;

  it("orders by overdueness and excludes not-due", () => {
    const a = mk("a", now - 2 * DAY, 10);
    const b = mk("b", now - 2 * DAY, 1);
    const c = mk("c", now + DAY, 1);
    expect(rankDue([a, c, b], now).map((x) => x.itemId)).toEqual(["b", "a"]);
    expect(overdueness(c.card, now)).toBeLessThan(0);
  });

  it("breaks ties by itemId", () => {
    const x = mk("x", now - DAY, 1);
    const y = mk("y", now - DAY, 1);
    expect(rankDue([y, x], now).map((i) => i.itemId)).toEqual(["x", "y"]);
  });

  it("property: sorted permutation of due subset", () => {
    const item = fc.record({
      itemId: fc.string({ maxLength: 4 }),
      due: fc.integer({ min: 0, max: 20 * DAY }),
      stability: fc.double({ min: 0.01, max: 100, noNaN: true }),
    });
    const cmp = (p: { itemId: string }, q: { itemId: string }) => (p.itemId < q.itemId ? -1 : 1);
    fc.assert(
      fc.property(fc.array(item, { maxLength: 20 }), (raw) => {
        const items = raw.map((r, i) => ({
          itemId: `${r.itemId}${String(i)}`,
          card: { ...s.newCard(0), due: r.due, stability: r.stability },
        }));
        const out = rankDue(items, 10 * DAY);
        const dueSet = items.filter((i) => i.card.due <= 10 * DAY);
        expect([...out].sort(cmp)).toEqual([...dueSet].sort(cmp));
        for (let i = 1; i < out.length; i++) {
          expect(overdueness(at(out, i - 1).card, 10 * DAY)).toBeGreaterThanOrEqual(
            overdueness(at(out, i).card, 10 * DAY),
          );
        }
        expect(rankDue(items, 10 * DAY)).toEqual(out);
      }),
    );
  });
});

describe("new item cap", () => {
  it("computes allowance", () => {
    expect(newItemAllowance({ introducedToday: 0 })).toBe(5);
    expect(newItemAllowance({ introducedToday: 3 })).toBe(2);
    expect(newItemAllowance({ introducedToday: 9 })).toBe(0);
    expect(newItemAllowance({ introducedToday: 1, cap: 2 })).toBe(1);
  });

  it("splits at 04:00 local rollover", () => {
    const tz = 600;
    const local = (h: number, m: number) => Date.UTC(2026, 9, 11, h, m) - tz * 60_000;
    const intros = [
      { at: local(3, 59), tzOffsetMin: tz },
      { at: local(4, 1), tzOffsetMin: tz },
      { at: local(23, 0), tzOffsetMin: tz },
    ];
    expect(countIntroducedOnDay(intros, "2026-10-10")).toBe(1);
    expect(countIntroducedOnDay(intros, "2026-10-11")).toBe(2);
  });

  it("same UTC instant lands on different days in +600 vs -240", () => {
    const at = Date.UTC(2026, 9, 11, 20, 0);
    expect(learnerDay(at, 600)).toBe("2026-10-12");
    expect(learnerDay(at, -240)).toBe("2026-10-11");
    const intros = [
      { at, tzOffsetMin: 600 },
      { at, tzOffsetMin: -240 },
    ];
    expect(countIntroducedOnDay(intros, "2026-10-12")).toBe(1);
    expect(countIntroducedOnDay(intros, "2026-10-11")).toBe(1);
  });
});
