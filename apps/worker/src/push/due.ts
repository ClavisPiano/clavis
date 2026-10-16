import { learnerDay } from "@clavis/core";
import type { PushSubscriptionRow } from "./repo";

/** Cron cadence in minutes (`triggers.crons` in wrangler.jsonc). A cue is due for this long. */
export const CUE_WINDOW_MIN = 15;

const MS_PER_MIN = 60_000;
const MS_PER_DAY = 86_400_000;
const MIN_PER_DAY = 1440;

/** "HH:MM" to minutes after local midnight, or null when malformed. */
export function parseTimeLocal(text: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export const weekdaysToMask = (days: readonly number[]): number =>
  days.reduce((mask, d) => mask | (1 << d), 0);

/** Local weekday (0 = Sunday) of an instant for a UTC offset in minutes east. */
function localWeekday(atMs: number, tzOffsetMin: number): number {
  const dayNumber = Math.floor((atMs + tzOffsetMin * MS_PER_MIN) / MS_PER_DAY);
  // 1970-01-01 was a Thursday.
  return (((dayNumber + 4) % 7) + 7) % 7;
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
  const cueMin = parseTimeLocal(sub.timeLocal);
  if (cueMin === null) return false;
  const localMin =
    ((Math.floor((nowMs + sub.tzOffsetMin * MS_PER_MIN) / MS_PER_MIN) % MIN_PER_DAY) +
      MIN_PER_DAY) %
    MIN_PER_DAY;
  const sinceCue = (localMin - cueMin + MIN_PER_DAY) % MIN_PER_DAY;
  if (sinceCue >= CUE_WINDOW_MIN) return false;
  const cueInstant = nowMs - sinceCue * MS_PER_MIN;
  if ((sub.weekdays & (1 << localWeekday(cueInstant, sub.tzOffsetMin))) === 0) return false;
  const today = learnerDay(nowMs, sub.tzOffsetMin);
  return sub.lastSentDay !== today && sub.lastPractisedDay !== today;
}

export const dueSubscriptions = (
  rows: readonly PushSubscriptionRow[],
  nowMs: number,
): PushSubscriptionRow[] => rows.filter((r) => isDue(r, nowMs));
