import type {
  AttemptError,
  AttemptOutcome,
  ExpectedResponse,
  InputSource,
  NoteEvent,
  PlayTarget,
} from "@clavis/core";
import { scoreChordLine } from "./chords.js";
import { scoreChoice, type ChoiceAnswer } from "./choice.js";
import { scoreLine } from "./line.js";
import { scorePerformance } from "./performance.js";
import { scoreRhythm } from "./rhythm.js";
import { scoreSequence } from "./sequence.js";
import { scoreExactPitch, scorePitchClass } from "./single.js";
import type { PartResult } from "./single.js";

export interface ScoreInput {
  expected: ExpectedResponse;
  notes: NoteEvent[];
  /** Same clock as `onsetMs` and `atMs`. */
  stimulusEndMs: number;
  source: InputSource;
  /** A picked option, for choice items (R21). Absent when nothing was picked. */
  choice?: ChoiceAnswer | undefined;
}

export interface ScoreResult {
  outcome: AttemptOutcome;
  subScores: { play?: number };
  /** Ordered by importance; the UI shows at most two. */
  errors: AttemptError[];
}

function scorePlay(play: PlayTarget, input: ScoreInput): PartResult {
  const base = {
    notes: input.notes,
    stimulusEndMs: input.stimulusEndMs,
    responseWindowMs: input.expected.responseWindowMs,
  };
  switch (play.kind) {
    case "pitchClass":
      return scorePitchClass({
        ...base,
        targetMidi: play.targetMidi,
        degreeLabels: play.degreeLabels,
      });
    case "exactPitch":
      return scoreExactPitch({ ...base, targetMidi: play.targetMidi });
    case "sequence":
      return scoreSequence({
        ...base,
        midi: play.midi,
        octaveAgnostic: play.octaveAgnostic,
        degreeLabels: play.degreeLabels,
      });
    case "choice":
      return scoreChoice({
        options: play.options,
        correct: play.correct,
        answer: input.choice,
        stimulusEndMs: input.stimulusEndMs,
        responseWindowMs: input.expected.responseWindowMs,
      });
    case "line":
      return scoreLine({
        ...base,
        midi: play.midi,
        onsetsBeats: play.onsetsBeats,
        tempoBpm: play.tempoBpm,
        source: input.source,
      });
    case "chordLine":
      return scoreChordLine({
        ...base,
        chords: play.chords,
        tempoBpm: play.tempoBpm,
        source: input.source,
        ...(play.gradeTiming === undefined ? {} : { gradeTiming: play.gradeTiming }),
      });
    case "performance":
      return scorePerformance({
        notes: play.notes,
        tempoBpm: play.tempoBpm,
        beatsPerBar: play.beatsPerBar,
        played: input.notes,
        stimulusEndMs: input.stimulusEndMs,
        responseWindowMs: input.expected.responseWindowMs,
        source: input.source,
      });
    case "rhythm":
      return scoreRhythm({
        ...base,
        onsetsBeats: play.onsetsBeats,
        tempoBpm: play.tempoBpm,
        source: input.source,
      });
  }
}

/**
 * Score the played part (R29). Only `expected.play` is graded: a legacy `sing` target (R12) is
 * ignored, and an item with no play target is a generator bug.
 */
export function scoreAttempt(input: ScoreInput): ScoreResult {
  const { play } = input.expected;
  if (play === undefined) {
    throw new RangeError("nothing to score: the item has no play target");
  }
  const played = scorePlay(play, input);
  return {
    outcome: played.outcome,
    subScores: { play: played.outcome.partial ?? (played.outcome.correct ? 1 : 0) },
    errors: played.errors,
  };
}
