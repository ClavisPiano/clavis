import type {
  AttemptError,
  AttemptOutcome,
  DegreeLabels,
  ExpectedResponse,
  InputSource,
  NoteEvent,
  PitchFrame,
  PlayTarget,
} from "@clavis/core";
import { scoreChordLine } from "./chords.js";
import { scoreChoice, type ChoiceAnswer } from "./choice.js";
import { scoreLine } from "./line.js";
import { scoreRhythm } from "./rhythm.js";
import { scoreSequence } from "./sequence.js";
import { scoreExactPitch, scorePitchClass } from "./single.js";
import type { PartResult } from "./single.js";
import { scoreSungPitch, scoreSungSequence } from "./sung.js";
import { req } from "./util.js";

export interface ScoreInput {
  expected: ExpectedResponse;
  notes: NoteEvent[];
  frames?: PitchFrame[];
  /** Same clock as `onsetMs` and `atMs`. */
  stimulusEndMs: number;
  source: InputSource;
  /** A picked option, for choice items (R21). Absent when nothing was picked. */
  choice?: ChoiceAnswer | undefined;
  /** Restrict scoring to one part. Default "both" (whatever the item expects). */
  part?: "sing" | "play" | "both";
}

export interface ScoreResult {
  outcome: AttemptOutcome;
  subScores: { sing?: number; play?: number };
  /** Ordered by importance; the UI shows at most two. */
  errors: AttemptError[];
}

function labelsOf(play: PlayTarget | undefined): DegreeLabels | undefined {
  return play?.kind === "pitchClass" || play?.kind === "sequence" ? play.degreeLabels : undefined;
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

const subScore = (o: AttemptOutcome): number => o.partial ?? (o.correct ? 1 : 0);

/** Mark each error with the part it came from, so feedback can say "you sang" or "you played". */
function tagPart(errors: readonly AttemptError[], part: "sing" | "play"): AttemptError[] {
  return errors.map((e) => ({ ...e, detail: { ...e.detail, part } }));
}

/**
 * R12 (amended): one outcome from the scored parts. Correct only when every part is correct
 * (spec 7: "sung pitch within 50 cents; key correct"). Latency comes from the played part when
 * there is one (finding the note is the fluency measure), else from the sung part. With two
 * parts, `partial` is the mean of their sub-scores. Errors are tagged with their part, played
 * first, without repeats.
 */
export function combineParts(parts: {
  sing?: PartResult | undefined;
  play?: PartResult | undefined;
}): Pick<ScoreResult, "outcome" | "errors"> {
  const { sing, play } = parts;
  const main = req(play ?? sing);
  let outcome: AttemptOutcome = main.outcome;
  if (sing && play) {
    const correct = sing.outcome.correct && play.outcome.correct;
    const anyPartial = sing.outcome.partial !== undefined || play.outcome.partial !== undefined;
    outcome = {
      correct,
      latencyMs: play.outcome.latencyMs,
      retries: Math.max(sing.outcome.retries, play.outcome.retries),
      ...(anyPartial ? { partial: (subScore(sing.outcome) + subScore(play.outcome)) / 2 } : {}),
    };
  }
  const seen = new Set<string>();
  const errors: AttemptError[] = [];
  for (const e of [
    ...(play ? tagPart(play.errors, "play") : []),
    ...(sing ? tagPart(sing.errors, "sing") : []),
  ]) {
    const key = JSON.stringify(e);
    if (!seen.has(key)) {
      seen.add(key);
      errors.push(e);
    }
  }
  return { outcome, errors };
}

/** Score whatever parts `input.part` asks for and combine them (see `combineParts`). */
export function scoreAttempt(input: ScoreInput): ScoreResult {
  const part = input.part ?? "both";
  const { sing, play } = input.expected;
  const doPlay = play !== undefined && part !== "sing";
  const doSing = sing !== undefined && part !== "play";
  if (!doPlay && !doSing) {
    throw new RangeError(`nothing to score: part "${part}" is not expected by this item`);
  }
  const frames = input.frames ?? [];
  const sung =
    part !== "play" && sing
      ? sing.kind === "sungPitch"
        ? scoreSungPitch({
            targetMidi: sing.targetMidi,
            toleranceCents: sing.toleranceCents,
            frames,
            stimulusEndMs: input.stimulusEndMs,
            responseWindowMs: input.expected.responseWindowMs,
            degreeLabels: sing.degreeLabels ?? labelsOf(play),
          })
        : scoreSungSequence({
            midi: sing.midi,
            frames,
            stimulusEndMs: input.stimulusEndMs,
            responseWindowMs: input.expected.responseWindowMs,
            degreeLabels: sing.degreeLabels ?? labelsOf(play),
          })
      : undefined;
  const played = part !== "sing" && play ? scorePlay(play, input) : undefined;

  const subScores: ScoreResult["subScores"] = {};
  if (sung) subScores.sing = subScore(sung.outcome);
  if (played) subScores.play = subScore(played.outcome);

  return { ...combineParts({ sing: sung, play: played }), subScores };
}
