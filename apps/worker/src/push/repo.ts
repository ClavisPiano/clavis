import type { AsyncSql, Statement } from "../auth/sql";
import { CUE_WINDOW_MIN, cueUtcMinute, utcMinuteOfDay } from "./cue-time";

/**
 * Devices one user may hold a cue on. Each cron run sends at most `MAX_SENDS_PER_RUN` pushes, so
 * without a cap one account could register endpoints until it crowds everyone else out. A new
 * device over the cap replaces that user's oldest subscription instead of being refused, so
 * turning the reminder on always works on the device in hand.
 */
export const MAX_SUBSCRIPTIONS_PER_USER = 10;

/** One stored push subscription (one per device) with its cue settings. */
export interface PushSubscriptionRow {
  endpoint: string;
  userId: string;
  p256dh: string;
  auth: string;
  /** "HH:MM" learner local time. */
  timeLocal: string;
  /** Bit mask, bit 0 = Sunday ... bit 6 = Saturday. */
  weekdays: number;
  /** Minutes east of UTC (R6). */
  tzOffsetMin: number;
  habit: string;
  lastSentDay: string | null;
  lastPractisedDay: string | null;
}

export type NewPushSubscription = Omit<PushSubscriptionRow, "lastSentDay" | "lastPractisedDay">;

export interface PushRepo {
  /**
   * Insert or replace by endpoint. A different user taking over an endpoint resets the sent day.
   * Then drops the user's oldest subscriptions beyond `MAX_SUBSCRIPTIONS_PER_USER`.
   */
  upsert(sub: NewPushSubscription, nowMs: number): Promise<void>;
  /** Delete only when the endpoint belongs to `userId`. Returns whether a row was removed. */
  deleteOwned(userId: string, endpoint: string): Promise<boolean>;
  /** Record that the user practised on `day` (applies to all their devices, never moves back). */
  markPractised(userId: string, day: string): Promise<void>;
  /**
   * Rows whose cue time is within the due window of `nowMs`, plus any row stored without its UTC
   * cue minute (written before the column existed), which is given one first. A superset of the
   * due cues: weekday, sent and practised days are still checked by `isDue`.
   */
  listNearDue(nowMs: number): Promise<PushSubscriptionRow[]>;
  /** The user's cue settings per device, without the endpoint or its keys (for the data export). */
  listCues(
    userId: string,
  ): Promise<
    { timeLocal: string; weekdays: number; tzOffsetMin: number; habit: string; createdAt: number }[]
  >;
  /** Apply the outcome of a cron run atomically: set sent days and delete dead endpoints. */
  applySendResults(sent: { endpoint: string; day: string }[], gone: string[]): Promise<void>;
}

interface Raw extends Record<string, unknown> {
  endpoint: string;
  user_id: string;
  p256dh: string;
  auth: string;
  time_local: string;
  weekdays: number;
  tz_offset_min: number;
  habit: string;
  last_sent_day: string | null;
  last_practised_day: string | null;
}

export function createPushRepo(sql: AsyncSql): PushRepo {
  return {
    async upsert(sub, nowMs) {
      await sql.batch([
        {
          query: `INSERT INTO push_subscriptions
             (endpoint, user_id, p256dh, auth, time_local, weekdays, tz_offset_min, habit, created_at,
              cue_utc_min)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (endpoint) DO UPDATE SET
             last_sent_day = CASE WHEN user_id = excluded.user_id THEN last_sent_day END,
             last_practised_day = CASE WHEN user_id = excluded.user_id THEN last_practised_day END,
             user_id = excluded.user_id,
             p256dh = excluded.p256dh,
             auth = excluded.auth,
             time_local = excluded.time_local,
             weekdays = excluded.weekdays,
             tz_offset_min = excluded.tz_offset_min,
             habit = excluded.habit,
             cue_utc_min = excluded.cue_utc_min`,
          bindings: [
            sub.endpoint,
            sub.userId,
            sub.p256dh,
            sub.auth,
            sub.timeLocal,
            sub.weekdays,
            sub.tzOffsetMin,
            sub.habit,
            nowMs,
            cueUtcMinute(sub.timeLocal, sub.tzOffsetMin),
          ],
        },
        {
          // The endpoint just written is always kept, even when its row is the oldest.
          query: `DELETE FROM push_subscriptions
           WHERE user_id = ? AND endpoint <> ? AND endpoint NOT IN (
             SELECT endpoint FROM push_subscriptions WHERE user_id = ? AND endpoint <> ?
             ORDER BY created_at DESC, endpoint DESC LIMIT ?
           )`,
          bindings: [
            sub.userId,
            sub.endpoint,
            sub.userId,
            sub.endpoint,
            MAX_SUBSCRIPTIONS_PER_USER - 1,
          ],
        },
      ]);
    },

    async deleteOwned(userId, endpoint) {
      const removed = await sql.all<{ endpoint: string }>(
        "DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ? RETURNING endpoint",
        endpoint,
        userId,
      );
      return removed.length > 0;
    },

    async listCues(userId) {
      const rows = await sql.all<{
        time_local: string;
        weekdays: number;
        tz_offset_min: number;
        habit: string;
        created_at: number;
      }>(
        "SELECT time_local, weekdays, tz_offset_min, habit, created_at FROM push_subscriptions WHERE user_id = ? ORDER BY created_at, endpoint",
        userId,
      );
      return rows.map((r) => ({
        timeLocal: r.time_local,
        weekdays: r.weekdays,
        tzOffsetMin: r.tz_offset_min,
        habit: r.habit,
        createdAt: r.created_at,
      }));
    },

    async markPractised(userId, day) {
      await sql.run(
        `UPDATE push_subscriptions SET last_practised_day = ?
         WHERE user_id = ? AND (last_practised_day IS NULL OR last_practised_day < ?)`,
        day,
        userId,
        day,
      );
    },

    async listNearDue(nowMs) {
      // Give rows from before the column existed their UTC cue minute, once.
      await sql.run(
        `UPDATE push_subscriptions SET cue_utc_min = (
           (
             CAST(substr(time_local, 1, 2) AS INTEGER) * 60 + CAST(substr(time_local, 4, 2) AS INTEGER)
             - tz_offset_min
           ) % 1440 + 1440
         ) % 1440
         WHERE cue_utc_min IS NULL AND time_local GLOB '[0-2][0-9]:[0-5][0-9]'`,
      );
      const rows = await sql.all<Raw>(
        `SELECT * FROM push_subscriptions
         WHERE cue_utc_min IS NULL OR ((? - cue_utc_min + 1440) % 1440) < ?`,
        utcMinuteOfDay(nowMs),
        CUE_WINDOW_MIN,
      );
      return rows.map((r) => ({
        endpoint: r.endpoint,
        userId: r.user_id,
        p256dh: r.p256dh,
        auth: r.auth,
        timeLocal: r.time_local,
        weekdays: r.weekdays,
        tzOffsetMin: r.tz_offset_min,
        habit: r.habit,
        lastSentDay: r.last_sent_day,
        lastPractisedDay: r.last_practised_day,
      }));
    },

    async applySendResults(sent, gone) {
      const statements: Statement[] = [
        ...sent.map((s) => ({
          query: "UPDATE push_subscriptions SET last_sent_day = ? WHERE endpoint = ?",
          bindings: [s.day, s.endpoint],
        })),
        ...gone.map((endpoint) => ({
          query: "DELETE FROM push_subscriptions WHERE endpoint = ?",
          bindings: [endpoint],
        })),
      ];
      if (statements.length > 0) await sql.batch(statements);
    },
  };
}
