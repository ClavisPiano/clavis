import type { LearningEvent } from "../events/schema.js";
import { learnerDay, type LearnerDay } from "../learning/day.js";

/*
 * Practice statistics for the Progress page (T6.1, spec 14). Pure functions of the event list:
 * the same events in any order, or with duplicates, give the same result, and nothing reads a
 * clock. A "day" is the learner day from R6 (the session's own `tzOffsetMin`, 04:00 rollover).
 */

/** A day counts as practised from one minute of session time (the Home row uses the same rule). */
export const PRACTISED_MIN_MS = 60_000;

export interface PracticeDay {
  day: LearnerDay;
  /** Session time in whole milliseconds, summed over the sessions that started on this day. */
  ms: number;
  /** `ms` in minutes (fractional). */
  minutes: number;
  attempts: number;
  sessions: number;
  practised: boolean;
}

interface SessionAcc {
  startedAt: number;
  tzOffsetMin: number;
  budgetSec: number;
  startId: string;
  endedAt?: number;
  lastEventAt: number;
}

/** Keep the first of each event id so replaying a log twice changes nothing. */
export function uniqueById(events: readonly LearningEvent[]): LearningEvent[] {
  const seen = new Set<string>();
  const out: LearningEvent[] = [];
  for (const e of events) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

/** Whether `a` sorts before `b` by (at, id). */
function before(a: { at: number; id: string }, b: { at: number; id: string }): boolean {
  return a.at !== b.at ? a.at < b.at : a.id < b.id;
}

export interface SessionSpan {
  sessionId: string;
  day: LearnerDay;
  startedAt: number;
  tzOffsetMin: number;
  /** Session time in ms. */
  ms: number;
}

/**
 * Per session: the earliest start, and an end that is the earliest `session.ended`, else the last
 * item or attempt event of that session, else the start itself (zero time). The span is capped at
 * twice the session budget, like the learner state fold, so an abandoned tab does not count as
 * hours.
 */
export function sessionSpans(events: readonly LearningEvent[]): SessionSpan[] {
  const acc = new Map<string, SessionAcc>();
  const unique = uniqueById(events);
  for (const e of unique) {
    if (e.type !== "session.started") continue;
    const prev = acc.get(e.sessionId);
    if (prev && !before({ at: e.at, id: e.id }, { at: prev.startedAt, id: prev.startId })) continue;
    acc.set(e.sessionId, {
      startedAt: e.at,
      tzOffsetMin: e.tzOffsetMin,
      budgetSec: e.budgetSec,
      startId: e.id,
      lastEventAt: e.at,
    });
  }
  for (const e of unique) {
    const s = "sessionId" in e ? acc.get(e.sessionId) : undefined;
    if (!s) continue;
    if (e.type === "session.ended") {
      if (s.endedAt === undefined || e.at < s.endedAt) s.endedAt = e.at;
    } else if (e.type === "item.presented" || e.type === "attempt.completed") {
      if (e.at > s.lastEventAt) s.lastEventAt = e.at;
    }
  }
  const spans: SessionSpan[] = [];
  for (const [sessionId, s] of acc) {
    const end = s.endedAt ?? s.lastEventAt;
    const ms = Math.min(Math.max(0, end - s.startedAt), 2 * s.budgetSec * 1000);
    spans.push({
      sessionId,
      day: learnerDay(s.startedAt, s.tzOffsetMin),
      startedAt: s.startedAt,
      tzOffsetMin: s.tzOffsetMin,
      ms,
    });
  }
  return spans.sort((a, b) => a.startedAt - b.startedAt || (a.sessionId < b.sessionId ? -1 : 1));
}

/**
 * Minutes and attempts per learner day, oldest first. Includes practice (`practice: true`) and
 * Away sessions. Placement writes no sessions or attempts, so it never appears here. Attempts
 * whose session is unknown are skipped (there is no timezone to place them in).
 */
export function practiceDays(events: readonly LearningEvent[]): PracticeDay[] {
  const unique = uniqueById(events);
  const spans = sessionSpans(unique);
  const dayOf = new Map<string, LearnerDay>();
  const byDay = new Map<LearnerDay, { ms: number; attempts: number; sessions: number }>();
  const cell = (day: LearnerDay) => {
    let c = byDay.get(day);
    if (!c) {
      c = { ms: 0, attempts: 0, sessions: 0 };
      byDay.set(day, c);
    }
    return c;
  };
  for (const s of spans) {
    dayOf.set(s.sessionId, s.day);
    const c = cell(s.day);
    c.ms += s.ms;
    c.sessions++;
  }
  for (const e of unique) {
    if (e.type !== "attempt.completed") continue;
    const day = dayOf.get(e.sessionId);
    if (day !== undefined) cell(day).attempts++;
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, c]) => ({
      day,
      ms: c.ms,
      minutes: c.ms / 60_000,
      attempts: c.attempts,
      sessions: c.sessions,
      practised: c.ms >= PRACTISED_MIN_MS,
    }));
}
