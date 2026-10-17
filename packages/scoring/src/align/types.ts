import type { InputSource } from "@clavis/core";

/** One note the score expects. Chords are several notes sharing `onsetBeats`. */
export interface ExpectedNote {
  id: string;
  midi: number;
  /** Onset in beats (the unit `tempoBpm` counts), from the start of the score. */
  onsetBeats: number;
  durationBeats: number;
}

/** One note the performer played. Polyphonic: several may overlap. */
export interface PerformedNote {
  midi: number;
  onsetMs: number;
  offsetMs?: number;
  velocity?: number;
}

export interface AlignOptions {
  source: InputSource;
  /** Override the per-source on-time tolerance (ms). */
  toleranceMs?: number;
  /** Override the per-source onset clustering window (ms). */
  clusterWindowMs?: number;
  /** A note held for less than this fraction of its expected length is `short`. Default 0.5. */
  shortFraction?: number;
}

export interface AlignInput {
  expected: readonly ExpectedNote[];
  /** Nominal tempo in beats per minute, in the same beat unit as `onsetBeats`. */
  tempoBpm: number;
  /** Time of beat 0 on the performed clock (end of the count-in). Optional. */
  countInRefMs?: number;
  performed: readonly PerformedNote[];
  options: AlignOptions;
}

export type NoteClass = "correct" | "wrongPitch" | "missed" | "early" | "late" | "short";

export interface NoteResult {
  /** Same order as the input `expected`. */
  id: string;
  midi: number;
  cls: NoteClass;
  /** Performed minus predicted onset in ms (negative is early). Absent for `missed`. */
  deviationMs?: number;
  /** Index into the input `performed` array of the note matched to this one. */
  performedIndex?: number;
  /** The pitch actually played, for `wrongPitch`. */
  playedMidi?: number;
}

export interface ExtraResult {
  performedIndex: number;
  midi: number;
  onsetMs: number;
}

export interface AlignSummary {
  /** Correct pitches over expected notes plus extra notes, in [0,1]. */
  pitchAccuracy: number;
  /** Mean timing credit of the notes with the right pitch, in [0,1]. */
  timingAccuracy: number;
  /** Fraction of expected notes that were played at all (not `missed`). */
  completeness: number;
  /** Weighted combination, see `OVERALL_WEIGHTS`. */
  overall: number;
}

export interface AlignResult {
  notes: NoteResult[];
  extras: ExtraResult[];
  summary: AlignSummary;
  /** Fitted performer tempo divided by the nominal tempo (below 1 is slower). */
  tempoRatio: number;
}
