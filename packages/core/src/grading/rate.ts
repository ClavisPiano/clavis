import type { AttemptOutcome } from "../events/learning.js";
import type { Rating, SessionMode } from "../learning/rating.js";

export interface RateOptions {
  /** Per-node latency target. When undefined, latency is ignored entirely (never `easy`). */
  targetLatencyMs?: number;
  mode: SessionMode;
}

/** Partial credit below this counts as a failed attempt. */
export const PARTIAL_FAIL_THRESHOLD = 0.6;
export const SLOW_FACTOR = 1.5;
export const FAST_FACTOR = 0.6;

/**
 * Turn an attempt outcome into an FSRS rating (spec 5.2).
 *
 * - `!correct` or `partial < 0.6` -> again
 * - any retry, or latency > 1.5x target -> hard
 * - latency <= 0.6x target -> easy
 * - otherwise good
 *
 * Without a `targetLatencyMs`, latency is ignored: the slow and fast branches
 * never fire, so such an attempt can be again, hard (retries only) or good,
 * and is never easy. Away mode caps the result at `good` (R3).
 */
export function rate(outcome: AttemptOutcome, opts: RateOptions): Rating {
  const target = opts.targetLatencyMs;
  let rating: Rating;
  if (!outcome.correct || (outcome.partial ?? 1) < PARTIAL_FAIL_THRESHOLD) {
    rating = "again";
  } else if (
    outcome.retries > 0 ||
    (target !== undefined && outcome.latencyMs > target * SLOW_FACTOR)
  ) {
    rating = "hard";
  } else if (target !== undefined && outcome.latencyMs <= target * FAST_FACTOR) {
    rating = "easy";
  } else {
    rating = "good";
  }
  if (opts.mode === "away" && rating === "easy") return "good";
  return rating;
}
