import { dayNumberToIso, type LearnerDay } from "../learning/day.js";
import type { PracticeDay } from "./days.js";

const MS_PER_DAY = 86_400_000;

/** 0 = Sunday ... 6 = Saturday, the same numbering as `Date.getUTCDay`. */
export type WeekStart = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Days since the epoch for an ISO date string. */
export function isoToDayNumber(day: LearnerDay): number {
  return Math.round(Date.parse(`${day}T00:00:00Z`) / MS_PER_DAY);
}

/** Weekday of a day number, 0 = Sunday (1970-01-01 was a Thursday). */
export function weekdayOfDayNumber(n: number): WeekStart {
  return ((((n + 4) % 7) + 7) % 7) as WeekStart;
}

/** First day number of the week containing day number `n`. */
export function weekStartDayNumber(n: number, weekStart: WeekStart): number {
  const back = (weekdayOfDayNumber(n) - weekStart + 7) % 7;
  return n - back;
}

/** The first day (ISO date) of the week containing `day`. */
export function weekStartOf(day: LearnerDay, weekStart: WeekStart): LearnerDay {
  return dayNumberToIso(weekStartDayNumber(isoToDayNumber(day), weekStart));
}

export interface WeekSummary {
  /** First day of the week. */
  start: LearnerDay;
  /** Last day of the week (start + 6). */
  end: LearnerDay;
  daysPractised: number;
  minutes: number;
  /** `daysPractised >= target`. */
  met: boolean;
  /** The week that contains `today`. */
  current: boolean;
}

export interface WeeklyProgress {
  target: number;
  /** The week containing `today`. Days after `today` do not exist yet, so they never count. */
  thisWeek: WeekSummary;
  /** The last `weeks` weeks, oldest first, ending with `thisWeek`. */
  recent: WeekSummary[];
}

/**
 * Days practised against a weekly target (spec 14), for this week and the weeks before it. There
 * is no streak: a week below target is just a shorter bar, and nothing carries over.
 */
export function weeklyProgress(
  days: readonly PracticeDay[],
  targetDaysPerWeek: number,
  today: LearnerDay,
  weekStart: WeekStart = 1,
  weeks = 8,
): WeeklyProgress {
  const todayN = isoToDayNumber(today);
  const thisStartN = weekStartDayNumber(todayN, weekStart);
  const count = Math.max(1, Math.floor(weeks));
  const recent: WeekSummary[] = [];
  for (let w = count - 1; w >= 0; w--) {
    const startN = thisStartN - 7 * w;
    let daysPractised = 0;
    let ms = 0;
    for (const d of days) {
      const n = isoToDayNumber(d.day);
      if (n < startN || n > startN + 6 || n > todayN) continue;
      ms += d.ms;
      if (d.practised) daysPractised++;
    }
    recent.push({
      start: dayNumberToIso(startN),
      end: dayNumberToIso(startN + 6),
      daysPractised,
      minutes: ms / 60_000,
      met: daysPractised >= targetDaysPerWeek,
      current: w === 0,
    });
  }
  const thisWeek = recent[recent.length - 1];
  if (!thisWeek) throw new Error("unreachable: at least one week");
  return { target: targetDaysPerWeek, thisWeek, recent };
}
