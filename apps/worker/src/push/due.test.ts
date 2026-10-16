import { describe, expect, it } from "vitest";
import { CUE_WINDOW_MIN, dueSubscriptions, isDue, parseTimeLocal, weekdaysToMask } from "./due";
import type { PushSubscriptionRow } from "./repo";

const ALL = weekdaysToMask([0, 1, 2, 3, 4, 5, 6]);

const sub = (over: Partial<PushSubscriptionRow> = {}): PushSubscriptionRow => ({
  endpoint: "https://push.example.com/a",
  userId: "u1",
  p256dh: "",
  auth: "",
  timeLocal: "08:00",
  weekdays: ALL,
  tzOffsetMin: 0,
  habit: "",
  lastSentDay: null,
  lastPractisedDay: null,
  ...over,
});

/** UTC instant for a local wall-clock time at `tzOffsetMin` east of UTC. */
const local = (y: number, mo: number, d: number, h: number, mi: number, tz: number): number =>
  Date.UTC(y, mo - 1, d, h, mi) - tz * 60_000;

// 2026-10-12 is a Monday.
describe("parseTimeLocal", () => {
  it.each([
    ["00:00", 0],
    ["08:05", 485],
    ["23:59", 1439],
    ["24:00", null],
    ["8:00", null],
    ["08:60", null],
    ["", null],
  ])("%s", (text, expected) => {
    expect(parseTimeLocal(text)).toBe(expected);
  });
});

describe("isDue time window across time zones", () => {
  it.each([
    ["+600 (Sydney), at 08:00 local", 600, local(2026, 10, 12, 8, 0, 600), true],
    ["+600, 14 minutes after", 600, local(2026, 10, 12, 8, 14, 600), true],
    ["+600, exactly one window after", 600, local(2026, 10, 12, 8, CUE_WINDOW_MIN, 600), false],
    ["+600, one minute before", 600, local(2026, 10, 12, 7, 59, 600), false],
    ["-300 (New York), at 08:00 local", -300, local(2026, 10, 12, 8, 0, -300), true],
    ["-300, but it is 08:00 in Sydney", -300, local(2026, 10, 12, 8, 0, 600), false],
    ["+600, but it is 08:00 in New York", 600, local(2026, 10, 12, 8, 0, -300), false],
    ["+345 (Kathmandu), at 08:00 local", 345, local(2026, 10, 12, 8, 0, 345), true],
  ])("%s", (_name, tz, now, expected) => {
    expect(isDue(sub({ tzOffsetMin: tz }), now)).toBe(expected);
  });

  it("selects only the subscriptions whose local time is now", () => {
    const sydney = sub({ endpoint: "https://push.example.com/syd", tzOffsetMin: 600 });
    const newYork = sub({ endpoint: "https://push.example.com/ny", tzOffsetMin: -300 });
    const now = local(2026, 10, 12, 8, 5, 600);
    expect(dueSubscriptions([sydney, newYork], now).map((s) => s.endpoint)).toEqual([
      "https://push.example.com/syd",
    ]);
  });
});

describe("isDue weekdays", () => {
  const mondayOnly = weekdaysToMask([1]);

  it("uses the learner's local weekday, not the UTC one", () => {
    // Monday 08:00 in Sydney is still Sunday in UTC.
    const now = local(2026, 10, 12, 8, 0, 600);
    expect(new Date(now).getUTCDay()).toBe(0);
    expect(isDue(sub({ tzOffsetMin: 600, weekdays: mondayOnly }), now)).toBe(true);
    expect(isDue(sub({ tzOffsetMin: 600, weekdays: weekdaysToMask([0]) }), now)).toBe(false);
  });

  it("uses the local weekday west of UTC too", () => {
    // Sunday 20:00 in New York is Monday in UTC.
    const now = local(2026, 10, 11, 20, 0, -300);
    expect(new Date(now).getUTCDay()).toBe(1);
    const evening = { timeLocal: "20:00", tzOffsetMin: -300 };
    expect(isDue(sub({ ...evening, weekdays: weekdaysToMask([0]) }), now)).toBe(true);
    expect(isDue(sub({ ...evening, weekdays: mondayOnly }), now)).toBe(false);
  });

  it("judges a cue that spills past midnight on the cue's own weekday", () => {
    // Cue at 23:55 on Monday, tick at 00:05 Tuesday local.
    const now = local(2026, 10, 13, 0, 5, 0);
    const late = { timeLocal: "23:55" };
    expect(isDue(sub({ ...late, weekdays: mondayOnly }), now)).toBe(true);
    expect(isDue(sub({ ...late, weekdays: weekdaysToMask([2]) }), now)).toBe(false);
  });

  it("is never due with no days selected", () => {
    expect(isDue(sub({ weekdays: 0 }), local(2026, 10, 12, 8, 0, 0))).toBe(false);
  });
});

describe("isDue sent and practised", () => {
  const now = local(2026, 10, 12, 8, 0, 600);
  const row = { tzOffsetMin: 600 };

  it("skips when already sent for this learner day", () => {
    expect(isDue(sub({ ...row, lastSentDay: "2026-10-12" }), now)).toBe(false);
  });

  it("sends when the last cue was another day", () => {
    expect(isDue(sub({ ...row, lastSentDay: "2026-10-11" }), now)).toBe(true);
  });

  it("skips when practised today", () => {
    expect(isDue(sub({ ...row, lastPractisedDay: "2026-10-12" }), now)).toBe(false);
  });

  it("still sends when only an earlier day was practised", () => {
    expect(isDue(sub({ ...row, lastPractisedDay: "2026-10-11" }), now)).toBe(true);
  });

  it("uses the 04:00 rollover: a 02:00 cue belongs to the previous learner day", () => {
    const early = { timeLocal: "02:00", tzOffsetMin: 0 };
    const at = local(2026, 10, 12, 2, 0, 0);
    expect(isDue(sub({ ...early, lastPractisedDay: "2026-10-11" }), at)).toBe(false);
    expect(isDue(sub({ ...early, lastPractisedDay: "2026-10-12" }), at)).toBe(true);
  });

  it("ignores a malformed stored time", () => {
    expect(isDue(sub({ timeLocal: "soon" }), now)).toBe(false);
  });
});
