import type { LearnerState } from "../state/types.js";
import { daysBetween, learnerDay } from "./day.js";

/**
 * A learner who has missed this many days or more is offered a shorter, lighter "welcome back"
 * session (R30). Three skipped days is enough for the due backlog to feel heavy and for recall to
 * have slipped, and fewer is just a long weekend.
 */
export const WELCOME_BACK_AFTER_DAYS = 3;

/**
 * Whole days missed before today: the learner days strictly between the last day they practised
 * and today. Zero when they have practised today, practised yesterday, or never practised (a new
 * learner has not "missed" anything). Any session counts, Away and extra practice included.
 */
export function missedDays(state: LearnerState, now: number, tzOffsetMin: number): number {
  const today = learnerDay(now, tzOffsetMin);
  let last: string | undefined;
  for (const [day, record] of Object.entries(state.daily)) {
    if (record.sessions <= 0 || day > today) continue;
    if (last === undefined || day > last) last = day;
  }
  if (last === undefined || last === today) return 0;
  return Math.max(0, daysBetween(last, today) - 1);
}

/** True when the learner has been away long enough to be offered the welcome-back session. */
export function shouldWelcomeBack(state: LearnerState, now: number, tzOffsetMin: number): boolean {
  return missedDays(state, now, tzOffsetMin) >= WELCOME_BACK_AFTER_DAYS;
}
