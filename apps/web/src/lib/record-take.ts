import { COUNT_IN_BEATS, matchNotes, noteName, takeTruth, type Take } from "@clavis/audio";
import type { NoteEvent } from "@clavis/core";

/*
 * Pure helpers for /dev/record: what to show the performer at a given moment of a take, and a quick
 * on-device score of the recording. Times are ms from the first count-in click (file time 0).
 */

export type Cue =
  | { phase: "count-in"; beatsLeft: number }
  | {
      phase: "play";
      /** Index of the note to play now (its onset has passed), or -1 before the first one. */
      index: number;
      now: string | undefined;
      next: string | undefined;
      total: number;
    }
  | { phase: "done" };

/** Notes that start together (two-hand takes) are shown as one cue, for example "C3 E3 G3". */
function groupLabel(take: Take, beat: number): string {
  return take.notes
    .filter((n) => n.beat === beat)
    .map((n) => noteName(n.midi))
    .join(" ");
}

export function cueAt(take: Take, elapsedMs: number): Cue {
  const beatMs = 60000 / take.bpm;
  const countInMs = COUNT_IN_BEATS * beatMs;
  if (elapsedMs < countInMs) {
    return { phase: "count-in", beatsLeft: COUNT_IN_BEATS - Math.floor(elapsedMs / beatMs) };
  }
  const beats = [...new Set(take.notes.map((n) => n.beat))].sort((a, b) => a - b);
  const last = take.notes.reduce((m, n) => Math.max(m, n.beat + n.durBeats), 0);
  const beat = (elapsedMs - countInMs) / beatMs;
  if (beat >= last) return { phase: "done" };
  let index = -1;
  beats.forEach((b, i) => {
    if (b <= beat) index = i;
  });
  const nowBeat = beats[index];
  const nextBeat = beats[index + 1];
  return {
    phase: "play",
    index,
    now: nowBeat === undefined ? undefined : groupLabel(take, nowBeat),
    next: nextBeat === undefined ? undefined : groupLabel(take, nextBeat),
    total: beats.length,
  };
}

/** Onset window for the on-device check. Wider than CI's 100 ms: a person playing to a click. */
export const DEVICE_ONSET_TOLERANCE_MS = 400;

export interface TakeNoteResult {
  expected: string;
  /** Detected note name, or undefined when nothing was heard near the onset. */
  heard: string | undefined;
  verdict: "exact" | "octave" | "wrong" | "missed";
}

export interface TakeScore {
  total: number;
  heard: number;
  exact: number;
  octaveErrors: number;
  wrong: number;
  missed: number;
  /** Exact pitch among the notes heard, the R20 measure (null when nothing was heard). */
  exactRate: number | null;
  notes: TakeNoteResult[];
}

export function scoreTake(
  take: Take,
  detected: readonly Pick<NoteEvent, "pitch" | "onsetMs">[],
  toleranceMs = DEVICE_ONSET_TOLERANCE_MS,
): TakeScore {
  const truth = takeTruth(take);
  const { pairs } = matchNotes(truth, detected, toleranceMs);
  const byTruth = new Map(pairs.map((p) => [p.truth, p.detectedPitch]));
  const notes: TakeNoteResult[] = truth.map((t) => {
    const pitch = byTruth.get(t);
    const expected = noteName(t.midi);
    if (pitch === undefined) return { expected, heard: undefined, verdict: "missed" };
    const heard = noteName(pitch);
    if (pitch === t.midi) return { expected, heard, verdict: "exact" };
    const samePc = (((pitch - t.midi) % 12) + 12) % 12 === 0;
    return { expected, heard, verdict: samePc ? "octave" : "wrong" };
  });
  const count = (v: TakeNoteResult["verdict"]): number =>
    notes.filter((n) => n.verdict === v).length;
  const heard = notes.length - count("missed");
  return {
    total: notes.length,
    heard,
    exact: count("exact"),
    octaveErrors: count("octave"),
    wrong: count("wrong"),
    missed: count("missed"),
    exactRate: heard === 0 ? null : count("exact") / heard,
    notes,
  };
}
