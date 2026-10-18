/*
 * Pure cue time helpers with no imports, so both the repository (which selects rows near "now" in
 * SQL) and the due logic can use them without importing each other.
 */

/** Cron cadence in minutes (`triggers.crons` in wrangler.jsonc). */
export const CRON_INTERVAL_MIN = 15;

/**
 * How long after its time a cue stays due. Two cron runs, so a cue left over when one run hits
 * `MAX_SENDS_PER_RUN` is sent by the next. `last_sent_day` keeps it to one send per learner day.
 */
export const CUE_WINDOW_MIN = 2 * CRON_INTERVAL_MIN;

const MS_PER_MIN = 60_000;
const MIN_PER_DAY = 1440;

/** "HH:MM" to minutes after local midnight, or null when malformed. */
export function parseTimeLocal(text: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * The UTC minute of the day (0 to 1439) at which a cue at `timeLocal` falls for a device
 * `tzOffsetMin` minutes east of UTC, or null when `timeLocal` is malformed. Stored with the
 * subscription so the cron can select rows near "now" in SQL.
 */
export function cueUtcMinute(timeLocal: string, tzOffsetMin: number): number | null {
  const cueMin = parseTimeLocal(timeLocal);
  if (cueMin === null) return null;
  return (((cueMin - tzOffsetMin) % MIN_PER_DAY) + MIN_PER_DAY) % MIN_PER_DAY;
}

/** The UTC minute of the day for an instant. */
export function utcMinuteOfDay(nowMs: number): number {
  return Math.floor(nowMs / MS_PER_MIN) % MIN_PER_DAY;
}
