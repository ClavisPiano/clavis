import type { LearningEvent } from "../events/schema.js";
import { dayNumberToIso, learnerDayNumber, type LearnerDay } from "../learning/day.js";
import { sessionSpans, uniqueById } from "./days.js";
import { isoToDayNumber, weekStartDayNumber } from "./weeks.js";

/*
 * Feedback calibration (spec 12, R28): how well the learner's own verdict on an answer
 * ("I got it right" or "I got it wrong", spec 8.4) matches the grade. Pure: the same events in any
 * order, or with duplicates, give the same result, and `today` is passed in.
 */

/** The headline numbers cover this many learner days, ending with today. */
export const CALIBRATION_WINDOW_DAYS = 28;
/** Weeks (Monday start) in the agreement trend, ending with the current week. */
export const CALIBRATION_TREND_WEEKS = 12;
/** The Progress page shows calibration from this many self-assessed attempts in the window. */
export const CALIBRATION_MIN_ATTEMPTS = 10;

export interface CalibrationWeek {
  /** Monday of the week, as a learner day. */
  week: LearnerDay;
  /** Self-assessed attempts in the week. */
  attempts: number;
  /** Share of them where the learner's verdict matched the grade, undefined when none. */
  agreement: number | undefined;
}

export interface Calibration {
  /** Self-assessed attempts in the last `CALIBRATION_WINDOW_DAYS` days. */
  attempts: number;
  /** Of those, the ones where the verdict matched `outcome.correct`. */
  agreed: number;
  /** `agreed / attempts`, undefined when there are no attempts. */
  agreement: number | undefined;
  /** Said "right" but the answer was wrong. */
  overconfident: number;
  /** Said "wrong" but the answer was right. */
  underconfident: number;
  /** `attempts >= CALIBRATION_MIN_ATTEMPTS`: enough to show. */
  enough: boolean;
  /** One slot per week, oldest first, ending with the week that contains `today`. */
  trend: CalibrationWeek[];
}

/**
 * Calibration over self-assessed attempts. An attempt's day is the learner day of its session (that
 * session's `tzOffsetMin`, R6); attempts whose session is unknown are left out, as in
 * `fluencyTrends`. Attempts after `today` are ignored.
 */
export function calibration(
  events: readonly LearningEvent[],
  today: LearnerDay,
  weeks: number = CALIBRATION_TREND_WEEKS,
): Calibration {
  const unique = uniqueById(events);
  const tzOf = new Map(sessionSpans(unique).map((s) => [s.sessionId, s.tzOffsetMin] as const));
  const todayN = isoToDayNumber(today);
  const windowStart = todayN - (CALIBRATION_WINDOW_DAYS - 1);
  const firstWeek = weekStartDayNumber(todayN, 1) - 7 * (weeks - 1);
  const perWeek = Array.from({ length: weeks }, () => ({ attempts: 0, agreed: 0 }));
  let attempts = 0;
  let agreed = 0;
  let overconfident = 0;
  let underconfident = 0;
  for (const e of unique) {
    if (e.type !== "attempt.completed" || e.selfAssessment === undefined) continue;
    const tz = tzOf.get(e.sessionId);
    if (tz === undefined) continue;
    const day = learnerDayNumber(e.at, tz);
    if (day > todayN) continue;
    const saidRight = e.selfAssessment === "right";
    const agrees = saidRight === e.outcome.correct;
    const slot = perWeek[Math.floor((day - firstWeek) / 7)];
    if (day >= firstWeek && slot) {
      slot.attempts++;
      if (agrees) slot.agreed++;
    }
    if (day < windowStart) continue;
    attempts++;
    if (agrees) agreed++;
    else if (saidRight) overconfident++;
    else underconfident++;
  }
  return {
    attempts,
    agreed,
    agreement: attempts > 0 ? agreed / attempts : undefined,
    overconfident,
    underconfident,
    enough: attempts >= CALIBRATION_MIN_ATTEMPTS,
    trend: perWeek.map((w, i) => ({
      week: dayNumberToIso(firstWeek + 7 * i),
      attempts: w.attempts,
      agreement: w.attempts > 0 ? w.agreed / w.attempts : undefined,
    })),
  };
}
