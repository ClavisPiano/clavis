import { describe, expect, it } from "vitest";
import { foldEvents } from "../state/reduce.js";
import { createScheduler } from "../scheduler/scheduler.js";
import type { DailyRecord, LearnerState } from "../state/types.js";
import { V1_GRAPH } from "../composer/fixtures/graph.js";
import { WELCOME_BACK_AFTER_DAYS, missedDays, shouldWelcomeBack } from "./missed.js";

const NOW = Date.UTC(2026, 2, 10, 10, 0, 0); // Tuesday 2026-03-10, mid learner day
const day = (record: Partial<DailyRecord> = {}): DailyRecord => ({
  newItems: 0,
  nodesIntroduced: 0,
  sessions: 1,
  practiceSec: 300,
  mode: { instrument: 1, away: 0 },
  ...record,
});
const withDays = (days: Record<string, DailyRecord>): LearnerState => ({
  ...foldEvents([], { graph: V1_GRAPH, scheduler: createScheduler() }),
  daily: days,
});

describe("missedDays", () => {
  it("is zero for a learner who never practised", () => {
    expect(missedDays(withDays({}), NOW, 0)).toBe(0);
  });

  it.each([
    ["today", "2026-03-10", 0],
    ["yesterday", "2026-03-09", 0],
    ["two days ago", "2026-03-08", 1],
    ["four days ago", "2026-03-06", 3],
    ["a month ago", "2026-02-08", 29],
  ])("counts only the whole days skipped: last practised %s", (_name, last, missed) => {
    expect(missedDays(withDays({ [last]: day() }), NOW, 0)).toBe(missed);
  });

  it("uses the most recent practised day, whatever order the days are in", () => {
    const state = withDays({ "2026-01-01": day(), "2026-03-05": day(), "2026-02-01": day() });
    expect(missedDays(state, NOW, 0)).toBe(4);
  });

  it("ignores days that only have a record without a session, and days in the future", () => {
    const state = withDays({
      "2026-03-04": day(),
      "2026-03-08": day({ sessions: 0, practiceSec: 0 }),
      "2026-03-20": day(),
    });
    expect(missedDays(state, NOW, 0)).toBe(5);
  });

  it("counts an Away session as practice", () => {
    const state = withDays({ "2026-03-09": day({ mode: { instrument: 0, away: 1 } }) });
    expect(missedDays(state, NOW, 0)).toBe(0);
  });

  it("follows the learner day, which rolls over at 04:00 local time", () => {
    const last = withDays({ "2026-03-06": day() });
    // 03:30 on the 10th in Sydney (+600) is still the 9th: one day fewer to count.
    const earlyMorning = Date.UTC(2026, 2, 9, 17, 30, 0);
    expect(missedDays(last, earlyMorning, 600)).toBe(2);
    expect(missedDays(last, Date.UTC(2026, 2, 9, 18, 30, 0), 600)).toBe(3);
  });
});

describe("shouldWelcomeBack", () => {
  it("switches on at the threshold and not before", () => {
    const lastPractised = (missed: number): LearnerState => {
      const d = new Date(NOW - (missed + 1) * 86_400_000).toISOString().slice(0, 10);
      return withDays({ [d]: day() });
    };
    expect(shouldWelcomeBack(lastPractised(WELCOME_BACK_AFTER_DAYS - 1), NOW, 0)).toBe(false);
    expect(shouldWelcomeBack(lastPractised(WELCOME_BACK_AFTER_DAYS), NOW, 0)).toBe(true);
    expect(shouldWelcomeBack(lastPractised(30), NOW, 0)).toBe(true);
  });

  it("is off for a new learner and for one who has already practised today", () => {
    expect(shouldWelcomeBack(withDays({}), NOW, 0)).toBe(false);
    expect(shouldWelcomeBack(withDays({ "2026-03-10": day(), "2026-02-01": day() }), NOW, 0)).toBe(
      false,
    );
  });
});
