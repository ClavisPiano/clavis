import { learnerDay, type LearnerDay } from "../learning/day.js";

/** Default new items introduced per learner day across all strands (spec 5.3). */
export const DEFAULT_NEW_ITEM_CAP = 5;

export function newItemAllowance(opts: { introducedToday: number; cap?: number }): number {
  return Math.max(0, (opts.cap ?? DEFAULT_NEW_ITEM_CAP) - opts.introducedToday);
}

export function countIntroducedOnDay(
  introductions: readonly { at: number; tzOffsetMin: number }[],
  day: LearnerDay,
): number {
  return introductions.filter((i) => learnerDay(i.at, i.tzOffsetMin) === day).length;
}
