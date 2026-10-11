/**
 * Learner-local calendar days (R6).
 *
 * `tzOffsetMin` is minutes EAST of UTC (Sydney standard time is +600), the
 * opposite sign of `Date.prototype.getTimezoneOffset()`. The day rolls over at
 * 04:00 local time so late-night practice counts toward the previous day.
 */
export const DAY_ROLLOVER_HOUR = 4;

const MS_PER_MIN = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/** Learner day as an ISO date string, e.g. "2026-10-11". */
export type LearnerDay = string;

/** Days since the Unix epoch for the learner-local day containing `atMs`. */
export function learnerDayNumber(atMs: number, tzOffsetMin: number): number {
  const shifted = atMs + tzOffsetMin * MS_PER_MIN - DAY_ROLLOVER_HOUR * MS_PER_HOUR;
  return Math.floor(shifted / MS_PER_DAY);
}

export function learnerDay(atMs: number, tzOffsetMin: number): LearnerDay {
  return dayNumberToIso(learnerDayNumber(atMs, tzOffsetMin));
}

export function dayNumberToIso(dayNumber: number): LearnerDay {
  return new Date(dayNumber * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (positive when `b` is later). */
export function daysBetween(a: LearnerDay, b: LearnerDay): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / MS_PER_DAY);
}
