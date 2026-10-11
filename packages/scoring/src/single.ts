import type { AttemptError, AttemptOutcome, DegreeLabels, NoteEvent } from "@clavis/core";
import { degreeConfusion, err, inWindow, pc, req } from "./util.js";

export interface PartResult {
  outcome: AttemptOutcome;
  errors: AttemptError[];
}

export interface SingleNoteInput {
  targetMidi: number;
  notes: readonly NoteEvent[];
  stimulusEndMs: number;
  responseWindowMs: number;
}

function scoreSingle(
  input: SingleNoteInput,
  matches: (n: NoteEvent) => boolean,
  wrongError: (n: NoteEvent) => AttemptError,
): PartResult {
  const notes = inWindow(input.notes, input.stimulusEndMs, input.responseWindowMs);
  const hit = notes.findIndex(matches);
  const errors: AttemptError[] = [];
  const wrongNotes = hit < 0 ? notes : notes.slice(0, hit);
  const seen = new Set<string>();
  for (const n of wrongNotes) {
    const e = wrongError(n);
    if (!seen.has(e.code)) {
      seen.add(e.code);
      errors.push(e);
    }
  }
  if (hit >= 0) {
    const n = req(notes[hit]);
    return {
      outcome: { correct: true, latencyMs: n.onsetMs - input.stimulusEndMs, retries: hit },
      errors,
    };
  }
  const last = notes[notes.length - 1];
  if (last === undefined) errors.push(err("response.timeout"));
  return {
    outcome: {
      correct: false,
      latencyMs: last === undefined ? input.responseWindowMs : last.onsetMs - input.stimulusEndMs,
      retries: wrongNotes.length,
    },
    errors,
  };
}

/** Pitch class match: octave does not matter. The first matching note is the answer. */
export function scorePitchClass(
  input: SingleNoteInput & { degreeLabels: DegreeLabels },
): PartResult {
  const target = pc(input.targetMidi);
  return scoreSingle(
    input,
    (n) => pc(n.pitch) === target,
    (n) => degreeConfusion(input.degreeLabels, input.targetMidi, n.pitch),
  );
}

/** Exact MIDI match. Right pitch class in the wrong octave gives `pitch.octave`. */
export function scoreExactPitch(input: SingleNoteInput): PartResult {
  const target = pc(input.targetMidi);
  return scoreSingle(
    input,
    (n) => n.pitch === input.targetMidi,
    (n) =>
      pc(n.pitch) === target
        ? err("pitch.octave", {
            expected: input.targetMidi,
            played: n.pitch,
            octaves: Math.round((n.pitch - input.targetMidi) / 12),
          })
        : err("pitch.wrong", { expected: input.targetMidi, played: n.pitch }),
  );
}
