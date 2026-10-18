import {
  placementPlan,
  type LearnerState,
  type PlacementPlan,
  type Rng,
  type SkillGraph,
} from "@clavis/core";
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

/**
 * The stored input choice placement honours. Placement is for the instrument, so a stored
 * on-screen keyboard choice is ignored (the mic answers), but a MIDI keyboard is the instrument
 * and is what lets the HANDS section run (R27).
 */
export function placementStoredInput(stored: string | null): "midi" | null {
  return stored === "midi" ? "midi" : null;
}

/**
 * The placement plan for the session's input (after any fallback): the HANDS section only with
 * MIDI, the one input that hears chords today (R26, R27). Otherwise the hands roots stay
 * available (R9).
 */
export function placementPlanFor(graph: SkillGraph, rng: Rng, inputKind: string): PlacementPlan {
  return placementPlan(graph, rng, { polyphonic: inputKind === "midi" });
}
