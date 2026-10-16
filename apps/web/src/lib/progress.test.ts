import { describe, expect, it } from "vitest";
import type { PracticeDay } from "@clavis/core";
import { calendarWeeks, levelForMinutes, sparkline, weeklySeries } from "./progress";

const day = (d: string, minutes: number): PracticeDay => ({
  day: d,
  ms: minutes * 60_000,
  minutes,
  attempts: 1,
  sessions: 1,
  practised: minutes >= 1,
});

describe("levelForMinutes", () => {
  it.each([
    [0, 0],
    [0.5, 0],
    [1, 1],
    [4.9, 1],
    [5, 2],
    [9.9, 2],
    [10, 3],
    [60, 3],
  ] as const)("%f min -> level %i", (m, level) => {
    expect(levelForMinutes(m)).toBe(level);
  });
});

describe("calendarWeeks", () => {
  // Wednesday 2026-10-14.
  const cols = calendarWeeks([day("2026-10-14", 6), day("2026-10-12", 0.5)], "2026-10-14", 12);

  it("has 12 Monday-first columns of 7 cells ending with this week", () => {
    expect(cols).toHaveLength(12);
    expect(cols.every((c) => c.length === 7)).toBe(true);
    const last = cols[11];
    expect(last?.[0]).toMatchObject({ day: "2026-10-12", weekday: "Mon" });
    expect(last?.[6]).toMatchObject({ day: "2026-10-18", weekday: "Sun" });
    expect(cols[0]?.[0]?.day).toBe("2026-07-27");
  });

  it("shades practised days, keeps missed days neutral and marks the future", () => {
    const last = cols[11] ?? [];
    expect(last[2]).toMatchObject({ day: "2026-10-14", level: 2, minutes: 6, isToday: true });
    expect(last[2]?.label).toBe("Wed 2026-10-14: 6 min practised, today");
    // Under a minute is not a practised day.
    expect(last[0]).toMatchObject({ level: 0, minutes: 0, future: false });
    expect(last[1]?.label).toBe("Tue 2026-10-13: no practice");
    expect(last[3]).toMatchObject({ future: true, level: 0 });
    expect(last[3]?.label).toBe("Thu 2026-10-15: later");
  });

  it("puts a Sunday at the end of its week", () => {
    const c = calendarWeeks([], "2026-10-18", 1);
    expect(c[0]?.map((x) => x.weekday)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(c[0]?.[6]?.isToday).toBe(true);
  });
});

describe("sparkline", () => {
  it("breaks the line at weeks without data and keeps lone points as dots", () => {
    const s = sparkline([0, 1, undefined, 0.5], 100, 40, { min: 0, max: 1 }, 0);
    expect(s.d).toBe("M0 40L33.3 0 M100 20");
    expect(s.dots.map((d) => d.index)).toEqual([0, 1, 3]);
  });

  it("centres a flat series and survives no data", () => {
    expect(sparkline([2, 2], 100, 40, undefined, 0).dots.map((d) => d.y)).toEqual([20, 20]);
    expect(sparkline([undefined], 100, 40)).toEqual({ d: "", dots: [] });
  });
});

describe("weeklySeries", () => {
  it("lines points up with the week starts", () => {
    const points = [
      { week: "2026-10-05", attempts: 2, accuracy: 0.5, medianLatencyMs: 1000 },
      { week: "2026-10-12", attempts: 2, accuracy: 1, medianLatencyMs: undefined },
    ];
    const weeks = ["2026-09-28", "2026-10-05", "2026-10-12"];
    expect(weeklySeries(points, weeks, (p) => p.accuracy)).toEqual([undefined, 0.5, 1]);
    expect(weeklySeries(points, weeks, (p) => p.medianLatencyMs)).toEqual([
      undefined,
      1000,
      undefined,
    ]);
  });
});
