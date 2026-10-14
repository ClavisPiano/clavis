import type { AttemptOutcome, InputSource, NoteEvent } from "@clavis/core";
import type { PartResult } from "./single.js";
import { scoreRhythm } from "./rhythm.js";
import { scoreSequence } from "./sequence.js";

/** Share of a line's partial score that comes from the pitches. The rest is rhythm. */
export const LINE_PITCH_WEIGHT = 0.7;

export interface LineInput {
  midi: readonly number[];
  onsetsBeats: readonly number[];
  tempoBpm: number;
  notes: readonly NoteEvent[];
  stimulusEndMs: number;
  responseWindowMs: number;
  source: InputSource;
}

/**
 * A line played from the score, graded in two stages (TP.4). Pitch comes first: the played notes
 * must match exactly, octave included. Rhythm is judged only once the pitches are right, so a
 * wrong note is reported as a wrong note and not also as a pile of timing errors. The line is
 * correct only when both stages pass. `partial` is `LINE_PITCH_WEIGHT` of the pitch score, plus
 * the rest from rhythm once pitch is right, so right notes with uneven timing still score well
 * above a wrong note. Latency is the first note after the reference time, as in the other scorers.
 */
export function scoreLine(input: LineInput): PartResult {
  const base = {
    notes: input.notes,
    stimulusEndMs: input.stimulusEndMs,
    responseWindowMs: input.responseWindowMs,
  };
  const pitch = scoreSequence({ ...base, midi: input.midi, octaveAgnostic: false });
  if (!pitch.outcome.correct) {
    const outcome: AttemptOutcome = {
      ...pitch.outcome,
      correct: false,
      partial: LINE_PITCH_WEIGHT * (pitch.outcome.partial ?? 0),
    };
    return { outcome, errors: pitch.errors };
  }
  const rhythm = scoreRhythm({
    ...base,
    onsetsBeats: input.onsetsBeats,
    tempoBpm: input.tempoBpm,
    source: input.source,
  });
  const outcome: AttemptOutcome = {
    correct: rhythm.outcome.correct,
    latencyMs: pitch.outcome.latencyMs,
    retries: 0,
    partial: LINE_PITCH_WEIGHT + (1 - LINE_PITCH_WEIGHT) * (rhythm.outcome.partial ?? 0),
  };
  return { outcome, errors: rhythm.errors };
}
