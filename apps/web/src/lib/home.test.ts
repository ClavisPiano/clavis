import { describe, expect, it } from "vitest";
import { learnerDay, type LearnerState } from "@clavis/core";
import {
  effectiveSettings,
  isFirstRun,
  lastDays,
  minutesLabel,
  noteName,
  presetFor,
  rangeError,
  settingsDiff,
  todaySummary,
  weekProgress,
} from "./home";

const SYD = 600; // +10:00
const at = (iso: string): number => Date.parse(iso);

function state(daily: Record<string, number>, sessions: Record<string, object> = {}): LearnerState {
  return {
    daily: Object.fromEntries(
      Object.entries(daily).map(([d, sec]) => [
        d,
        {
          newItems: 0,
          nodesIntroduced: 0,
          sessions: 1,
          practiceSec: sec,
          mode: { instrument: 1, away: 0 },
        },
      ]),
    ),
    sessions,
    settings: {},
  } as unknown as LearnerState;
}

describe("noteName and presets", () => {
  it("names MIDI notes", () => {
    expect(noteName(60)).toBe("C4");
    expect(noteName(40)).toBe("E2");
    expect(noteName(69)).toBe("A4");
    expect(noteName(70)).toBe("A#4");
    expect(noteName(21)).toBe("A0");
  });
  it("maps presets both ways", () => {
    expect(presetFor(40, 64)?.id).toBe("low");
    expect(presetFor(45, 69)?.id).toBe("mid");
    expect(presetFor(48, 72)?.id).toBe("high");
    expect(presetFor(48, 73)).toBeUndefined();
  });
  it("blocks low >= high", () => {
    expect(rangeError(60, 60)).toBeDefined();
    expect(rangeError(61, 60)).toBeDefined();
    expect(rangeError(48, 72)).toBeUndefined();
  });
});

describe("settings", () => {
  it("applies defaults", () => {
    const e = effectiveSettings({});
    expect(e.budgetSec).toBe(720);
    expect(e.awayBudgetSec).toBe(300);
    expect([e.voiceRangeLow, e.voiceRangeHigh]).toEqual([48, 72]);
    expect(e.weeklyTargetDays).toBe(5);
    expect(minutesLabel(e.budgetSec)).toBe("12 min");
  });
  it("diffs only changed keys", () => {
    const cur = effectiveSettings({});
    expect(settingsDiff(cur, cur)).toBeUndefined();
    expect(settingsDiff(cur, { ...cur, budgetSec: 900, voiceRangeLow: 45 })).toEqual({
      budgetSec: 900,
      voiceRangeLow: 45,
    });
    expect(settingsDiff(cur, { ...cur, headphones: false })).toEqual({ headphones: false });
    expect(
      settingsDiff({ ...cur, headphones: true }, { ...cur, headphones: true }),
    ).toBeUndefined();
  });
});

describe("today and the 7-day row", () => {
  it("rolls over at 04:00 local time", () => {
    // 03:30 on 2026-10-11 in +10:00 is still learner day 2026-10-10.
    const early = at("2026-10-10T17:30:00Z");
    const later = at("2026-10-10T18:30:00Z"); // 04:30 local, learner day 2026-10-11
    const s = state({ "2026-10-10": 600 });
    expect(todaySummary(s, early, SYD).day).toBe("2026-10-10");
    expect(todaySummary(s, early, SYD).minutes).toBe(10);
    expect(todaySummary(s, later, SYD).day).toBe("2026-10-11");
    expect(todaySummary(s, later, SYD).minutes).toBe(0);
  });

  it("depends on the timezone", () => {
    const now = at("2026-10-11T20:00:00Z");
    expect(learnerDay(now, 0)).toBe("2026-10-11");
    expect(todaySummary(state({}), now, 0).day).toBe("2026-10-11");
    expect(todaySummary(state({}), now, SYD).day).toBe("2026-10-12");
    expect(todaySummary(state({}), now, -480).day).toBe("2026-10-11");
  });

  it("reports completed and open sessions", () => {
    const now = at("2026-10-11T12:00:00Z");
    const base = { mode: "instrument", startedAt: now, budgetSec: 720, itemsPresented: 0 };
    const open = { a: { ...base, day: "2026-10-11" } };
    const done = { a: { ...base, day: "2026-10-11", endedAt: now + 1 } };
    const old = { a: { ...base, day: "2026-10-09" } };
    expect(todaySummary(state({}, open), now, 0)).toMatchObject({
      completed: false,
      hasOpenSession: true,
    });
    expect(todaySummary(state({}, done), now, 0)).toMatchObject({
      completed: true,
      hasOpenSession: false,
    });
    expect(todaySummary(state({}, old), now, 0)).toMatchObject({
      completed: false,
      hasOpenSession: false,
    });
  });

  it("builds seven cells, oldest first, with neutral gaps", () => {
    const now = at("2026-10-11T12:00:00Z"); // a Sunday
    const cells = lastDays(
      state({ "2026-10-11": 720, "2026-10-09": 240, "2026-10-08": 30, "2026-10-06": 400 }),
      now,
      0,
    );
    expect(cells.map((c) => c.day)).toEqual([
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
      "2026-10-10",
      "2026-10-11",
    ]);
    expect(cells.map((c) => c.weekday)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(cells.map((c) => c.level)).toEqual([0, 2, 0, 0, 1, 0, 3]);
    expect(cells.filter((c) => c.isToday)).toHaveLength(1);
    expect(cells.at(-1)?.isToday).toBe(true);
  });

  it("uses the learner day at the rollover for the row", () => {
    const now = at("2026-10-10T17:30:00Z"); // 03:30 on the 11th in +10, learner day the 10th
    const cells = lastDays(state({ "2026-10-10": 300 }), now, SYD);
    expect(cells.at(-1)).toMatchObject({ day: "2026-10-10", isToday: true, practised: true });
  });

  it("counts days against the target without streak semantics", () => {
    const now = at("2026-10-11T12:00:00Z");
    const cells = lastDays(
      state({ "2026-10-11": 600, "2026-10-09": 600, "2026-10-05": 600, "2026-10-04": 600 }),
      now,
      0,
    );
    // 2026-10-04 is outside the window.
    expect(weekProgress(cells, 5)).toEqual({ daysPractised: 3, target: 5, met: false });
    expect(weekProgress(cells, 3).met).toBe(true);
  });
});

describe("isFirstRun", () => {
  it("is true until a session exists", () => {
    expect(isFirstRun(state({}))).toBe(true);
    expect(isFirstRun(state({}, { a: {} }))).toBe(false);
  });
});
