import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { LearningEvent } from "../events/schema.js";
import { Builder, DAY_MS } from "../state/test-helpers.js";
import {
  CALIBRATION_MIN_ATTEMPTS,
  CALIBRATION_TREND_WEEKS,
  CALIBRATION_WINDOW_DAYS,
  calibration,
} from "./index.js";

const MIN = 60_000;
/** A Wednesday. Its week starts on Monday 2026-03-02. */
const TODAY = "2026-03-04";
const NOON_TODAY = Date.parse(`${TODAY}T12:00:00Z`);

type Verdict = "right" | "wrong";

/** One session `daysAgo` before today with these (correct, verdict) answers. */
function day(
  b: Builder,
  n: number,
  daysAgo: number,
  answers: readonly [boolean, Verdict | undefined][],
  tz = 0,
): LearningEvent[] {
  const sid = b.sessionId(n);
  const at = NOON_TODAY - daysAgo * DAY_MS - tz * MIN;
  const out: LearningEvent[] = [b.start(at, sid, { tz })];
  answers.forEach(([correct, selfAssessment], i) => {
    out.push(
      ...b.item(at + (i + 1) * MIN, sid, "n1", `n1|i=${String(n)}-${String(i)}`, {
        correct,
        ...(selfAssessment ? { selfAssessment } : {}),
      }),
    );
  });
  return out;
}

describe("calibration: agreement, over- and underconfidence", () => {
  it.each<{
    name: string;
    answers: [boolean, Verdict | undefined][];
    attempts: number;
    agreed: number;
    agreement: number | undefined;
    over: number;
    under: number;
  }>([
    {
      name: "nothing self-assessed",
      answers: [],
      attempts: 0,
      agreed: 0,
      agreement: undefined,
      over: 0,
      under: 0,
    },
    {
      name: "unassessed attempts do not count",
      answers: [
        [true, undefined],
        [false, undefined],
      ],
      attempts: 0,
      agreed: 0,
      agreement: undefined,
      over: 0,
      under: 0,
    },
    {
      name: "right and was right, wrong and was wrong",
      answers: [
        [true, "right"],
        [false, "wrong"],
      ],
      attempts: 2,
      agreed: 2,
      agreement: 1,
      over: 0,
      under: 0,
    },
    {
      name: "said right but was wrong is overconfident",
      answers: [
        [false, "right"],
        [true, "right"],
      ],
      attempts: 2,
      agreed: 1,
      agreement: 0.5,
      over: 1,
      under: 0,
    },
    {
      name: "said wrong but was right is underconfident",
      answers: [
        [true, "wrong"],
        [true, "wrong"],
        [true, "right"],
        [false, "wrong"],
      ],
      attempts: 4,
      agreed: 2,
      agreement: 0.5,
      over: 0,
      under: 2,
    },
  ])("$name", ({ answers, attempts, agreed, agreement, over, under }) => {
    const b = new Builder();
    const c = calibration(day(b, 1, 0, answers), TODAY);
    expect(c).toMatchObject({
      attempts,
      agreed,
      agreement,
      overconfident: over,
      underconfident: under,
    });
  });
});

describe("calibration: the 28-day window", () => {
  it.each([
    // [days before today, counted in the headline numbers]
    [0, true],
    [CALIBRATION_WINDOW_DAYS - 1, true],
    [CALIBRATION_WINDOW_DAYS, false],
    [60, false],
    [-1, false], // after today: not counted anywhere
  ] as const)("%i days ago counted: %s", (daysAgo, counted) => {
    const b = new Builder();
    const c = calibration(day(b, 1, daysAgo, [[true, "right"]]), TODAY);
    expect(c.attempts).toBe(counted ? 1 : 0);
  });

  it("uses the session's learner day (04:00 rollover in its time zone)", () => {
    const b = new Builder();
    const sid = b.sessionId(1);
    // 03:00 local on Thursday (+10h) is still Wednesday, today; 05:00 local is tomorrow.
    const early = Date.parse("2026-03-04T17:00:00Z");
    const late = Date.parse("2026-03-04T19:00:00Z");
    const events = [
      b.start(early - MIN, sid, { tz: 600 }),
      ...b.item(early, sid, "n1", "a", { selfAssessment: "right" }),
      ...b.item(late, sid, "n1", "b", { selfAssessment: "right" }),
    ];
    expect(calibration(events, TODAY).attempts).toBe(1);
  });

  it("leaves out attempts whose session is unknown", () => {
    const b = new Builder();
    const events = day(b, 1, 0, [[true, "right"]]).filter((e) => e.type !== "session.started");
    expect(calibration(events, TODAY).attempts).toBe(0);
  });

  it(`is enough to show from ${String(CALIBRATION_MIN_ATTEMPTS)} self-assessed attempts`, () => {
    const b = new Builder();
    const nine = Array.from({ length: CALIBRATION_MIN_ATTEMPTS - 1 }, (): [boolean, Verdict] => [
      true,
      "right",
    ]);
    expect(calibration(day(b, 1, 0, [...nine]), TODAY).enough).toBe(false);
    expect(calibration(day(b, 2, 0, [...nine, [false, "right"]]), TODAY).enough).toBe(true);
    // Old attempts do not make it enough.
    const old = day(b, 3, CALIBRATION_WINDOW_DAYS + 7, [...nine, [true, "wrong"]]);
    expect(calibration(old, TODAY).enough).toBe(false);
  });
});

describe("calibration: weekly trend", () => {
  it("has one slot per week for 12 weeks, oldest first, ending with this week", () => {
    const c = calibration([], TODAY);
    expect(c.trend).toHaveLength(CALIBRATION_TREND_WEEKS);
    expect(c.trend[CALIBRATION_TREND_WEEKS - 1]?.week).toBe("2026-03-02");
    expect(c.trend[0]?.week).toBe("2025-12-15");
    expect(c.trend.every((w) => w.attempts === 0 && w.agreement === undefined)).toBe(true);
  });

  it("gives each week its agreement, including weeks outside the 28-day window", () => {
    const b = new Builder();
    const events = [
      // Monday this week (2 days ago): 2 of 3 agree.
      ...day(b, 1, 2, [
        [true, "right"],
        [false, "wrong"],
        [false, "right"],
      ]),
      // Sunday last week (3 days ago): 0 of 1.
      ...day(b, 2, 3, [[true, "wrong"]]),
      // Ten weeks ago: 1 of 1, outside the headline window.
      ...day(b, 3, 70, [[true, "right"]]),
      // Thirteen weeks ago: before the trend.
      ...day(b, 4, 91, [[true, "right"]]),
    ];
    const c = calibration(events, TODAY);
    const byWeek = Object.fromEntries(c.trend.map((w) => [w.week, w]));
    expect(byWeek["2026-03-02"]).toEqual({ week: "2026-03-02", attempts: 3, agreement: 2 / 3 });
    expect(byWeek["2026-02-23"]).toEqual({ week: "2026-02-23", attempts: 1, agreement: 0 });
    expect(byWeek["2025-12-22"]).toEqual({ week: "2025-12-22", attempts: 1, agreement: 1 });
    expect(c.trend.reduce((n, w) => n + w.attempts, 0)).toBe(5);
    expect(c.attempts).toBe(4);
    expect(c.agreement).toBe(0.5);
  });
});

describe("calibration: order independence", () => {
  const answer = fc.tuple(
    fc.boolean(),
    fc.constantFrom<Verdict | undefined>("right", "wrong", undefined),
  );
  const arb = fc
    .array(fc.tuple(fc.integer({ min: -2, max: 100 }), fc.array(answer, { maxLength: 4 })), {
      maxLength: 6,
    })
    .chain((plans) => {
      const b = new Builder();
      const events = plans.flatMap(([daysAgo, answers], i) => day(b, i + 1, daysAgo, answers));
      return fc
        .shuffledSubarray(events, { minLength: events.length, maxLength: events.length })
        .map((shuffled) => ({ events, shuffled }));
    });

  it("does not depend on event order or replayed duplicates", () => {
    fc.assert(
      fc.property(arb, ({ events, shuffled }) => {
        const c = calibration(events, TODAY);
        expect(calibration(shuffled, TODAY)).toEqual(c);
        expect(calibration([...events, ...shuffled], TODAY)).toEqual(c);
        expect(c.agreed + c.overconfident + c.underconfident).toBe(c.attempts);
      }),
    );
  });
});
