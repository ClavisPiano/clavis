import type { LearnerDay } from "../learning/day.js";
import type { SessionMode } from "../learning/rating.js";
import type { MasteryCriteria, NodeState } from "../graph/schema.js";

/** One graded attempt on a node, as input to mastery evaluation. Ordered oldest to newest. */
export interface GradedAttempt {
  at: number;
  sessionId: string;
  day: LearnerDay;
  mode: SessionMode;
  correct: boolean;
  partial?: number;
  latencyMs: number;
}

/** Margin below `minAccuracy` at which a mastered node is demoted (spec 3.2). */
export const DEMOTION_MARGIN = 0.1;

export function attemptScore(a: GradedAttempt): number {
  return a.correct ? (a.partial ?? 1) : 0;
}

/** The last `n` items (all of them when fewer exist). */
function lastN<T>(xs: readonly T[], n: number): T[] {
  return xs.slice(Math.max(0, xs.length - n));
}

/** Mean score over the last `window` attempts. Returns 0 for an empty slice. */
export function windowAccuracy(attempts: readonly GradedAttempt[], window: number): number {
  const w = lastN(attempts, window);
  if (w.length === 0) return 0;
  let sum = 0;
  for (const a of w) sum += attemptScore(a);
  return sum / w.length;
}

/** Median of a list of numbers; NaN for an empty list. */
export function median(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  const hi = s[mid] ?? 0;
  return s.length % 2 === 1 ? hi : ((s[mid - 1] ?? 0) + hi) / 2;
}

/** Fluent: at least `windowAttempts` attempts (any mode) and accuracy >= minAccuracy over the last window. */
export function fluentConditionMet(
  attempts: readonly GradedAttempt[],
  criteria: MasteryCriteria,
): boolean {
  if (attempts.length < criteria.windowAttempts) return false;
  return windowAccuracy(attempts, criteria.windowAttempts) >= criteria.minAccuracy;
}

/**
 * Mastered: over the last `windowAttempts` instrument-mode attempts (Away never
 * counts, R3), accuracy >= minAccuracy, median latency of the correct ones
 * <= maxMedianLatencyMs (when defined), and at least `distinctSessions`
 * distinct sessions falling on at least `distinctSessions` distinct learner days.
 */
export function masteredConditionMet(
  attempts: readonly GradedAttempt[],
  criteria: MasteryCriteria,
): boolean {
  const inst = attempts.filter((a) => a.mode === "instrument");
  if (inst.length < criteria.windowAttempts) return false;
  const w = lastN(inst, criteria.windowAttempts);
  if (windowAccuracy(w, criteria.windowAttempts) < criteria.minAccuracy) return false;
  if (criteria.maxMedianLatencyMs !== undefined) {
    const lat = w.filter((a) => a.correct).map((a) => a.latencyMs);
    // No correct attempts means no latency evidence: not mastered.
    if (lat.length === 0 || median(lat) > criteria.maxMedianLatencyMs) return false;
  }
  const sessions = new Set(w.map((a) => a.sessionId));
  const days = new Set(w.map((a) => a.day));
  return sessions.size >= criteria.distinctSessions && days.size >= criteria.distinctSessions;
}

/** Demotion: rolling accuracy over the last window (any mode) strictly below minAccuracy - 0.1. */
export function demotionConditionMet(
  attempts: readonly GradedAttempt[],
  criteria: MasteryCriteria,
): boolean {
  if (attempts.length === 0) return false;
  return windowAccuracy(attempts, criteria.windowAttempts) < criteria.minAccuracy - DEMOTION_MARGIN;
}

/**
 * Re-evaluate a node's state from its attempt history (oldest to newest).
 *
 * Only learning, fluent and mastered nodes move; locked and available are
 * returned unchanged (unlocking and introduction belong to the reducer).
 *
 * - learning -> fluent when the fluent condition holds.
 * - learning -> mastered directly when the mastered condition holds (mastered
 *   implies fluent, so the intermediate step would only add a round trip).
 * - fluent -> mastered when the mastered condition holds.
 * - mastered -> fluent when demotion triggers. There is no demotion below
 *   fluent: the spec defines none, and a regressing fluent node is handled by
 *   the scheduler through lapses instead.
 */
export function evaluateNodeState(
  current: NodeState,
  attempts: readonly GradedAttempt[],
  criteria: MasteryCriteria,
): NodeState {
  switch (current) {
    case "locked":
    case "available":
      return current;
    case "learning":
      if (masteredConditionMet(attempts, criteria)) return "mastered";
      return fluentConditionMet(attempts, criteria) ? "fluent" : "learning";
    case "fluent":
      return masteredConditionMet(attempts, criteria) ? "mastered" : "fluent";
    case "mastered":
      return demotionConditionMet(attempts, criteria) ? "fluent" : "mastered";
  }
}
