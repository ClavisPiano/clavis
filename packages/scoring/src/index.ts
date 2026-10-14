export const PACKAGE_NAME = "@clavis/scoring";

export { combineParts, scoreAttempt } from "./score.js";
export type { ScoreInput, ScoreResult } from "./score.js";
export { scoreChoice } from "./choice.js";
export { LINE_PITCH_WEIGHT, scoreLine } from "./line.js";
export type { LineInput } from "./line.js";
export type { ChoiceAnswer, ChoiceInput } from "./choice.js";
export { scorePitchClass, scoreExactPitch } from "./single.js";
export type { PartResult, SingleNoteInput } from "./single.js";
export {
  SUNG_DEFAULTS,
  findStableSegments,
  segmentSungNotes,
  scoreSungPitch,
  scoreSungSequence,
} from "./sung.js";
export type { SungOptions, SungSegment, SungPitchInput, SungSequenceInput } from "./sung.js";
export { align, compareSequences, scoreSequence } from "./sequence.js";
export type { AlignOp, Alignment, SequenceInput, SequenceScore } from "./sequence.js";
export {
  RHYTHM_TOLERANCE_MS,
  TEMPO_DRIFT_THRESHOLD,
  analyseRhythm,
  scoreRhythm,
} from "./rhythm.js";
export type { RhythmAnalysis, RhythmClass, RhythmInput } from "./rhythm.js";
