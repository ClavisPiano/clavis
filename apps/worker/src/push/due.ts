import { learnerDay } from "@clavis/core";
import {
  CRON_INTERVAL_MIN,
  CUE_WINDOW_MIN,
  cueUtcMinute,
  parseTimeLocal,
  utcMinuteOfDay,
} from "./cue-time";
import type { PushSubscriptionRow } from "./repo";

export { CRON_INTERVAL_MIN, CUE_WINDOW_MIN, cueUtcMinute, parseTimeLocal, utcMinuteOfDay };

const MS_PER_MIN = 60_000;
const MS_PER_DAY = 86_400_000;
const MIN_PER_DAY = 1440;

export const weekdaysToMask = (days: readonly number[]): number =>
  days.reduce((mask, d) => mask | (1 << d), 0);

/** Local weekday (0 = Sunday) of an instant for a UTC offset in minutes east. */
function localWeekday(atMs: number, tzOffsetMin: number): number {
  const dayNumber = Math.floor((atMs + tzOffsetMin * MS_PER_MIN) / MS_PER_DAY);
  // 1970-01-01 was a Thursday.
  return (((dayNumber + 4) % 7) + 7) % 7;
}

/** Minutes since the cue time in the subscription's local time, 0 to 1439, or null if malformed. */
export function minutesSinceCue(sub: PushSubscriptionRow, nowMs: number): number | null {
  const cueMin = parseTimeLocal(sub.timeLocal);
  if (cueMin === null) return null;
  const localMin =
    ((Math.floor((nowMs + sub.tzOffsetMin * MS_PER_MIN) / MS_PER_MIN) % MIN_PER_DAY) +
      MIN_PER_DAY) %
    MIN_PER_DAY;
  return (localMin - cueMin + MIN_PER_DAY) % MIN_PER_DAY;
}

/**
 * True when this subscription should be sent a cue now:
 * - the local time is within `CUE_WINDOW_MIN` after the cue time (so a cue just before midnight
 *   still fires when the tick lands just after it, judged on that cue's own weekday),
 * - the cue's weekday is selected,
 * - nothing was sent for today's learner day (R6, 04:00 rollover), and
 * - the learner has not already practised today.
 */
export function isDue(sub: PushSubscriptionRow, nowMs: number): boolean {
  const sinceCue = minutesSinceCue(sub, nowMs);
  if (sinceCue === null || sinceCue >= CUE_WINDOW_MIN) return false;
  const cueInstant = nowMs - sinceCue * MS_PER_MIN;
  if ((sub.weekdays & (1 << localWeekday(cueInstant, sub.tzOffsetMin))) === 0) return false;
  const today = learnerDay(nowMs, sub.tzOffsetMin);
  return sub.lastSentDay !== today && sub.lastPractisedDay !== today;
}

/**
 * The due subscriptions, longest overdue first, so cues carried over from a run that hit the send
 * cap go out before ones that only just became due.
 */
export function dueSubscriptions(
  rows: readonly PushSubscriptionRow[],
  nowMs: number,
): PushSubscriptionRow[] {
  return rows
    .filter((r) => isDue(r, nowMs))
    .map((r) => ({ r, since: minutesSinceCue(r, nowMs) ?? 0 }))
    .sort((a, b) => b.since - a.since)
    .map(({ r }) => r);
}
