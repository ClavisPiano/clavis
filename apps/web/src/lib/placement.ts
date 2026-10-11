import type { LearnerState } from "@clavis/core";
import { isFirstRun } from "./home";

/** Device meta: the learner chose Skip on the first-run placement offer. */
export const PLACEMENT_SKIPPED_META_KEY = "placement.skipped";

/** Has a placement ever been completed? A placed node carries its floor. */
export function hasPlacement(state: LearnerState): boolean {
  return Object.values(state.nodes).some((n) => n.placementFloor !== undefined);
}

/**
 * First-run offer rule: no session has ever been started, no placement is recorded, and the
 * learner has not skipped the offer. Someone who imported history, or who has practised, is
 * never asked.
 */
export function shouldOfferPlacement(state: LearnerState, skipped: boolean): boolean {
  return !skipped && isFirstRun(state) && !hasPlacement(state);
}
