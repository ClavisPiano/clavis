import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { LearningEvent } from "../events/schema.js";
import type { SkillGraph } from "../graph/schema.js";
import { Builder, DAY_MS, FIXTURE_GRAPH, T0 } from "../state/test-helpers.js";
import {
  fluencyTrends,
  practiceDays,
  sessionSpans,
  weekStartOf,
  weeklyProgress,
  type PracticeDay,
} from "./index.js";

const MIN = 60_000;
const iso = (s: string): number => Date.parse(s);

/** The fixture graph with n3 moved to READ and n5 to HANDS, so strands can be told apart. */
const GRAPH: SkillGraph = {
  ...FIXTURE_GRAPH,
  nodes: FIXTURE_GRAPH.nodes.map((n) =>
    n.id === "n3"
      ? { ...n, strand: "READ" as const }
      : n.id === "n5"
        ? { ...n, strand: "HANDS" as const }
        : n,
  ),
};

/** One session that starts at `at`, answers once after one minute and ends after `lenMin`. */
function session(
  b: Builder,
  n: number,
  at: number,
  lenMin: number,
  o: { tz?: number; mode?: "instrument" | "away"; practice?: boolean; end?: boolean } = {},
): LearningEvent[] {
  const sid = b.sessionId(n);
  const start = b.start(at, sid, {
    ...(o.tz !== undefined ? { tz: o.tz } : {}),
    ...(o.mode ? { mode: o.mode } : {}),
    ...(o.practice !== undefined ? { practice: o.practice } : {}),
  });
  const events = [start, ...b.item(at + MIN, sid, "n1", `n1|i=${String(n)}`)];
  if (o.end !== false) events.push(b.end(at + lenMin * MIN, sid));
  return events;
}

describe("practiceDays: learner day boundaries", () => {
  it.each([
    // [session start (UTC), tzOffsetMin, expected learner day]
    ["2026-01-01T13:30:00Z", 600, "2026-01-01"], // 23:30 local, east of UTC
    ["2026-01-01T17:59:00Z", 600, "2026-01-01"], // 03:59 local the next calendar day: still Jan 1
    ["2026-01-01T18:00:00Z", 600, "2026-01-02"], // 04:00 local: rollover
    ["2026-01-02T04:30:00Z", -300, "2026-01-01"], // 23:30 local, west of UTC
    ["2026-01-02T08:59:00Z", -300, "2026-01-01"], // 03:59 local Jan 2
    ["2026-01-02T09:00:00Z", -300, "2026-01-02"], // 04:00 local Jan 2
    ["2026-01-01T23:30:00Z", 0, "2026-01-01"],
    ["2026-01-01T03:59:00Z", 0, "2025-12-31"],
    ["2026-01-01T12:00:00Z", 840, "2026-01-01"], // 02:00 next day local (+14h): before rollover
    ["2026-01-01T12:00:00Z", -720, "2025-12-31"], // 00:00 local Jan 1 (-12h): before rollover
  ] as const)("session at %s with offset %i is on %s", (utc, tz, expected) => {
    const b = new Builder();
    const days = practiceDays(session(b, 1, iso(utc), 10, { tz }));
    expect(days.map((d) => d.day)).toEqual([expected]);
  });

  it("uses each session's own offset when the learner travels", () => {
    const b = new Builder();
    const events = [
      ...session(b, 1, iso("2026-01-01T13:30:00Z"), 5, { tz: 600 }), // Jan 1 local
      ...session(b, 2, iso("2026-01-02T04:30:00Z"), 5, { tz: -300 }), // Jan 1 local
    ];
    const days = practiceDays(events);
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ day: "2026-01-01", sessions: 2, attempts: 2, minutes: 10 });
  });
});

describe("practiceDays: minutes and attempts", () => {
  it("uses the end event, counts attempts, and flags practised days", () => {
    const b = new Builder();
    const days = practiceDays([
      ...session(b, 1, T0 + 10 * 3600_000, 7),
      ...session(b, 2, T0 + 11 * 3600_000, 0.5),
    ]);
    expect(days).toEqual([
      {
        day: "2026-01-01",
        ms: 7.5 * MIN,
        minutes: 7.5,
        attempts: 2,
        sessions: 2,
        practised: true,
      },
    ]);
  });

  it("falls back to the last item or attempt for a session that never ended", () => {
    const b = new Builder();
    const sid = b.sessionId(1);
    const events = [
      b.start(T0 + 10 * 3600_000, sid),
      ...b.item(T0 + 10 * 3600_000 + 2 * MIN, sid, "n1", "a"),
      ...b.item(T0 + 10 * 3600_000 + 4 * MIN, sid, "n1", "b", { latencyMs: 1000 }),
    ];
    expect(practiceDays(events)[0]).toMatchObject({ ms: 4 * MIN + 1000, attempts: 2 });
  });

  it("gives a started session with nothing else zero minutes and not practised", () => {
    const b = new Builder();
    const days = practiceDays([b.start(T0 + 10 * 3600_000, b.sessionId(1))]);
    expect(days).toEqual([
      { day: "2026-01-01", ms: 0, minutes: 0, attempts: 0, sessions: 1, practised: false },
    ]);
  });

  it("caps a span at twice the budget", () => {
    const b = new Builder();
    const sid = b.sessionId(1);
    const events = [
      b.start(T0 + 10 * 3600_000, sid, { budgetSec: 600 }),
      b.end(T0 + 20 * 3600_000, sid),
    ];
    expect(practiceDays(events)[0]?.minutes).toBe(20);
    expect(sessionSpans(events)[0]?.ms).toBe(20 * MIN);
  });

  it("includes practice and Away sessions", () => {
    const b = new Builder();
    const days = practiceDays([
      ...session(b, 1, T0 + 10 * 3600_000, 5, { practice: true }),
      ...session(b, 2, T0 + 12 * 3600_000, 3, { mode: "away" }),
    ]);
    expect(days[0]).toMatchObject({ sessions: 2, minutes: 8, attempts: 2 });
  });

  it("ignores attempts of unknown sessions and duplicate event ids, and leaves gaps empty", () => {
    const b = new Builder();
    const events = [
      ...session(b, 1, T0 + 10 * 3600_000, 5),
      ...session(b, 2, T0 + 3 * DAY_MS + 10 * 3600_000, 5),
      ...b.item(T0 + 1000, b.sessionId(99), "n1", "orphan"),
    ];
    const once = practiceDays(events);
    expect(once.map((d) => d.day)).toEqual(["2026-01-01", "2026-01-04"]);
    expect(practiceDays([...events, ...events])).toEqual(once);
  });

  it("returns nothing for no events", () => {
    expect(practiceDays([])).toEqual([]);
  });
});

function day(d: string, minutes: number): PracticeDay {
  return {
    day: d,
    ms: minutes * MIN,
    minutes,
    attempts: 1,
    sessions: 1,
    practised: minutes >= 1,
  };
}

describe("weekStartOf", () => {
  it.each([
    ["2026-01-01", 1, "2025-12-29"], // Thursday -> Monday
    ["2025-12-29", 1, "2025-12-29"],
    ["2026-01-04", 1, "2025-12-29"], // Sunday belongs to the Monday week before
    ["2026-01-05", 1, "2026-01-05"],
    ["2026-01-01", 0, "2025-12-28"], // Sunday start
    ["2026-01-04", 0, "2026-01-04"],
  ] as const)("%s with week start %i is %s", (d, ws, expected) => {
    expect(weekStartOf(d, ws)).toBe(expected);
  });
});

describe("weeklyProgress", () => {
  // Today is Wednesday 2026-01-07. Monday weeks.
  const days = [
    day("2025-12-29", 5), // previous week
    day("2025-12-30", 5),
    day("2026-01-03", 0.5), // under a minute: not practised
    day("2026-01-05", 10), // this week
    day("2026-01-06", 3),
    day("2026-01-09", 20), // future, ignored
  ];

  it("counts practised days this week against the target", () => {
    const p = weeklyProgress(days, 5, "2026-01-07", 1, 3);
    expect(p.thisWeek).toMatchObject({
      start: "2026-01-05",
      end: "2026-01-11",
      daysPractised: 2,
      minutes: 13,
      met: false,
      current: true,
    });
    expect(p.target).toBe(5);
  });

  it("lists the last N weeks oldest first", () => {
    const p = weeklyProgress(days, 2, "2026-01-07", 1, 3);
    expect(p.recent.map((w) => [w.start, w.daysPractised, w.met, w.current])).toEqual([
      ["2025-12-22", 0, false, false],
      ["2025-12-29", 2, true, false],
      ["2026-01-05", 2, true, true],
    ]);
  });

  it("honours a Sunday week start", () => {
    // Sunday-start week of Wed Jan 7 begins Sun Jan 4: only Jan 5 and Jan 6 count.
    const p = weeklyProgress(days, 5, "2026-01-07", 0, 1);
    expect(p.thisWeek).toMatchObject({ start: "2026-01-04", daysPractised: 2 });
  });

  it("puts a Sunday in the week that ends on it with Monday weeks", () => {
    const p = weeklyProgress([day("2026-01-04", 5)], 1, "2026-01-04", 1, 2);
    expect(p.thisWeek).toMatchObject({ start: "2025-12-29", daysPractised: 1, met: true });
  });

  it("treats a missed week as empty, not as a break", () => {
    const p = weeklyProgress([], 5, "2026-01-07", 1, 4);
    expect(p.recent.map((w) => w.daysPractised)).toEqual([0, 0, 0, 0]);
  });
});

describe("fluencyTrends", () => {
  it("groups by strand and ISO week with accuracy and median latency of passing attempts", () => {
    const b = new Builder();
    const sid = b.sessionId(1);
    const sid2 = b.sessionId(2);
    const at = iso("2026-01-05T10:00:00Z"); // Monday of week 2026-01-05
    const events = [
      b.start(at, sid),
      ...b.item(at + MIN, sid, "n1", "a", { latencyMs: 1000 }),
      ...b.item(at + 2 * MIN, sid, "n1", "b", { latencyMs: 3000 }),
      ...b.item(at + 3 * MIN, sid, "n1", "c", { latencyMs: 9000, correct: false }),
      ...b.item(at + 4 * MIN, sid, "n1", "d", { latencyMs: 2000 }),
      ...b.item(at + 5 * MIN, sid, "n3", "r", { latencyMs: 4000 }),
      b.start(at - DAY_MS, sid2), // Sunday: previous ISO week
      ...b.item(at - DAY_MS + MIN, sid2, "n1", "e", { latencyMs: 500 }),
      ...b.item(at - DAY_MS + 2 * MIN, sid2, "n5", "h", { correct: false }),
    ];
    const t = fluencyTrends(events, GRAPH);
    expect(t.map((s) => s.strand)).toEqual(["EAR", "READ", "HANDS"]);
    expect(t[0]?.points).toEqual([
      { week: "2025-12-29", attempts: 1, accuracy: 1, medianLatencyMs: 500 },
      { week: "2026-01-05", attempts: 4, accuracy: 0.75, medianLatencyMs: 2000 },
    ]);
    expect(t[1]?.points).toEqual([
      { week: "2026-01-05", attempts: 1, accuracy: 1, medianLatencyMs: 4000 },
    ]);
    // All attempts wrong: accuracy 0 and no latency.
    expect(t[2]?.points).toEqual([
      { week: "2025-12-29", attempts: 1, accuracy: 0, medianLatencyMs: undefined },
    ]);
  });

  it.each([
    // Sunday 2026-01-04 13:30 UTC, then 17:30 UTC and 18:30 UTC, at +600
    ["2026-01-04T13:30:00Z", 600, "2025-12-29"], // 23:30 Sunday local
    ["2026-01-04T17:30:00Z", 600, "2025-12-29"], // 03:30 Monday local, before rollover
    ["2026-01-04T18:30:00Z", 600, "2026-01-05"], // 04:30 Monday local
    ["2026-01-05T04:30:00Z", -300, "2025-12-29"], // 23:30 Sunday local, west of UTC
    ["2026-01-05T09:30:00Z", -300, "2026-01-05"], // 04:30 Monday local
  ] as const)("an attempt at %s with offset %i falls in week %s", (utc, tz, week) => {
    const b = new Builder();
    const sid = b.sessionId(1);
    const at = iso(utc);
    const events = [b.start(at, sid, { tz }), ...b.item(at + MIN, sid, "n1", "a")];
    expect(fluencyTrends(events, GRAPH)[0]?.points[0]?.week).toBe(week);
  });

  it("skips unknown nodes, orphan attempts and placement, and handles no events", () => {
    const b = new Builder();
    const sid = b.sessionId(1);
    const events = [
      b.place(T0, { n1: "mastered" }),
      b.start(T0 + 10 * 3600_000, sid),
      ...b.item(T0 + 10 * 3600_000 + MIN, sid, "ghost", "x"),
      ...b.item(T0 + 10 * 3600_000 + MIN, b.sessionId(7), "n1", "y"),
    ];
    expect(fluencyTrends(events, GRAPH)).toEqual([]);
    expect(fluencyTrends([], GRAPH)).toEqual([]);
  });
});

/* ---------- order independence ---------- */

const attemptPlan = fc.record({
  node: fc.constantFrom("n1", "n2", "n3", "n5"),
  correct: fc.boolean(),
  latencyMs: fc.integer({ min: 200, max: 6000 }),
});

const sessionPlan = fc.record({
  day: fc.integer({ min: 0, max: 20 }),
  hour: fc.integer({ min: 0, max: 23 }),
  tz: fc.constantFrom(0, 600, -300, 840, -720),
  mode: fc.constantFrom("instrument" as const, "away" as const),
  practice: fc.boolean(),
  ended: fc.boolean(),
  lenMin: fc.integer({ min: 0, max: 30 }),
  attempts: fc.array(attemptPlan, { maxLength: 5 }),
});

type Plan = typeof sessionPlan extends fc.Arbitrary<infer T> ? T : never;

function build(plans: readonly Plan[]): LearningEvent[] {
  const b = new Builder();
  const events: LearningEvent[] = [];
  plans.forEach((p, i) => {
    const sid = b.sessionId(i);
    const at = T0 + p.day * DAY_MS + p.hour * 3600_000;
    events.push(b.start(at, sid, { tz: p.tz, mode: p.mode, practice: p.practice }));
    p.attempts.forEach((a, j) => {
      events.push(
        ...b.item(at + (j + 1) * MIN, sid, a.node, `${a.node}|${String(j)}`, {
          correct: a.correct,
          latencyMs: a.latencyMs,
        }),
      );
    });
    if (p.ended) events.push(b.end(at + p.lenMin * MIN, sid));
  });
  return events;
}

describe("order independence", () => {
  const arb = fc.array(sessionPlan, { minLength: 0, maxLength: 8 }).chain((plans) => {
    const events = build(plans);
    return fc
      .shuffledSubarray(events, { minLength: events.length, maxLength: events.length })
      .map((shuffled) => ({ events, shuffled }));
  });

  it("practiceDays, weeklyProgress and fluencyTrends do not depend on event order", () => {
    fc.assert(
      fc.property(arb, fc.integer({ min: 1, max: 7 }), ({ events, shuffled }, target) => {
        expect(practiceDays(shuffled)).toEqual(practiceDays(events));
        expect(fluencyTrends(shuffled, GRAPH)).toEqual(fluencyTrends(events, GRAPH));
        const today = "2026-01-21";
        expect(weeklyProgress(practiceDays(shuffled), target, today)).toEqual(
          weeklyProgress(practiceDays(events), target, today),
        );
      }),
    );
  });

  it("is idempotent when the log is replayed twice", () => {
    fc.assert(
      fc.property(arb, ({ events }) => {
        expect(practiceDays([...events, ...events])).toEqual(practiceDays(events));
        expect(fluencyTrends([...events, ...events], GRAPH)).toEqual(fluencyTrends(events, GRAPH));
      }),
    );
  });
});
