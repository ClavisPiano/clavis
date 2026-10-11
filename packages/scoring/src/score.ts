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

/** R12: the outcome comes from the played part when one was scored, else from the sung part. */
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
            degreeLabels: labelsOf(play),
          })
        : scoreSungSequence({
            midi: sing.midi,
            frames,
            stimulusEndMs: input.stimulusEndMs,
            responseWindowMs: input.expected.responseWindowMs,
            degreeLabels: labelsOf(play),
          })
      : undefined;
  const played = part !== "sing" && play ? scorePlay(play, input) : undefined;

  const subScores: ScoreResult["subScores"] = {};
  if (sung) subScores.sing = subScore(sung.outcome);
  if (played) subScores.play = subScore(played.outcome);

  const main = req(played ?? sung);
  const seen = new Set<string>();
  const errors: AttemptError[] = [];
  for (const e of [...(played?.errors ?? []), ...(sung?.errors ?? [])]) {
    const key = JSON.stringify(e);
    if (!seen.has(key)) {
      seen.add(key);
      errors.push(e);
    }
  }
  return { outcome: main.outcome, subScores, errors };
}
