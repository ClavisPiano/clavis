import type { InputSource } from "@clavis/core";

export interface Tolerance {
  /**
   * Largest deviation (ms) from the locally predicted onset that still counts as on time.
   * Beyond it a note is early or late.
   */
  onTimeMs: number;
  /** Notes closer than this (ms) are one onset cluster: a rolled or slightly smeared chord. */
  clusterMs: number;
}

/**
 * Tolerances by input source.
 *
 * - midi: key-down times are exact, so the only spread is the player's own. Trained pianists keep
 *   a steady pulse within about 20 to 30 ms; 60 ms is roughly where a deviation is audible as
 *   uneven. Chords played "together" spread over 20 to 40 ms, so 60 ms also groups them.
 * - tap: a tap on a screen adds touch and display latency jitter (about 20 to 40 ms) on top.
 * - mic: onset detection from pitch frames lags and jitters by a frame or two (10 to 30 ms per
 *   frame hop plus smoothing) and sustained piano decay blurs attacks, so it needs the widest
 *   window. This matches the ordering of `RHYTHM_TOLERANCE_MS`.
 */
export const TOLERANCES: Record<InputSource, Tolerance> = {
  midi: { onTimeMs: 60, clusterMs: 60 },
  tap: { onTimeMs: 90, clusterMs: 80 },
  mic: { onTimeMs: 120, clusterMs: 100 },
};

/** Weights of the overall score. They sum to 1. */
export const OVERALL_WEIGHTS = { pitch: 0.5, timing: 0.3, completeness: 0.2 } as const;

/** A held note shorter than this fraction of its written length is `short`. */
export const SHORT_FRACTION = 0.5;
