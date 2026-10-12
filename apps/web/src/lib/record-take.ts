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
      /** 0..1 through the gap until the next note is due (1 when there is none). */
      towardNext: number;
    }
  | { phase: "done" };

/** The distinct beats at which notes start, in order. One click is played on each. */
export function noteBeats(take: Take): number[] {
  return [...new Set(take.notes.map((n) => n.beat))].sort((a, b) => a - b);
}

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
  const beats = noteBeats(take);
  const last = take.notes.reduce((m, n) => Math.max(m, n.beat + n.durBeats), 0);
  const beat = (elapsedMs - countInMs) / beatMs;
  if (beat >= last) return { phase: "done" };
  let index = -1;
  beats.forEach((b, i) => {
    if (b <= beat) index = i;
  });
  const nowBeat = beats[index];
  const nextBeat = beats[index + 1];
  const from = nowBeat ?? 0;
  const towardNext =
    nextBeat === undefined ? 1 : Math.min(1, Math.max(0, (beat - from) / (nextBeat - from)));
  return {
    phase: "play",
    index,
    now: nowBeat === undefined ? undefined : groupLabel(take, nowBeat),
    next: nextBeat === undefined ? undefined : groupLabel(take, nextBeat),
    total: beats.length,
    towardNext,
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
  return scoreNotes(takeTruth(take), detected, toleranceMs);
}

/** A ground-truth note, as in a fixture manifest. */
export interface TruthLike {
  midi: number;
  onsetMs: number;
  offsetMs?: number | undefined;
}

/** Score detected notes against ground truth (from the score, or heard onsets when self-paced). */
export function scoreNotes(
  truth: readonly TruthLike[],
  detected: readonly Pick<NoteEvent, "pitch" | "onsetMs">[],
  toleranceMs = DEVICE_ONSET_TOLERANCE_MS,
): TakeScore {
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

export interface OnsetDetectorOptions {
  /** RMS window. */
  windowMs?: number;
  /**
   * A window this many times louder than the quietest of the last few counts as an attack. Tuned
   * on a real digital piano bass take (C2 to E4): 2x over the last 100 ms catches a soft note
   * played over the previous one still ringing.
   */
  riseRatio?: number;
  /** How many earlier windows the rise is measured against. */
  lookbackWindows?: number;
  /** Ignore anything quieter than this RMS (room noise). */
  minRms?: number;
  /** After an onset, ignore further attacks for this long (one key, one onset). */
  refractoryMs?: number;
}

/**
 * Finds note attacks in a mono stream by a sharp rise in short-window RMS, so a new note is heard
 * even over the previous one ringing on. Feed samples in order with their absolute frame index;
 * returns the frames where attacks start. Used to pace self-paced takes; pitch is the pipeline's job.
 */
export class OnsetDetector {
  readonly #window: number;
  readonly #riseRatio: number;
  readonly #lookback: number;
  readonly #minRms: number;
  readonly #refractory: number;
  readonly #recent: number[] = [];
  #sum = 0;
  #count = 0;
  #windowStart = 0;
  #lastOnset = Number.NEGATIVE_INFINITY;
  /** RMS of the last complete window, for a level meter. */
  level = 0;

  constructor(sampleRate: number, opts: OnsetDetectorOptions = {}) {
    this.#window = Math.max(1, Math.round(((opts.windowMs ?? 20) * sampleRate) / 1000));
    this.#riseRatio = opts.riseRatio ?? 2;
    this.#lookback = opts.lookbackWindows ?? 5;
    this.#minRms = opts.minRms ?? 0.01;
    this.#refractory = Math.round(((opts.refractoryMs ?? 300) * sampleRate) / 1000);
  }

  push(samples: Float32Array, startFrame: number): number[] {
    const onsets: number[] = [];
    for (let i = 0; i < samples.length; i++) {
      if (this.#count === 0) this.#windowStart = startFrame + i;
      const x = samples[i] ?? 0;
      this.#sum += x * x;
      this.#count++;
      if (this.#count < this.#window) continue;
      const rms = Math.sqrt(this.#sum / this.#count);
      this.level = rms;
      const floor = this.#recent.length < this.#lookback ? Infinity : Math.min(...this.#recent);
      if (
        rms >= this.#minRms &&
        rms > floor * this.#riseRatio &&
        this.#windowStart - this.#lastOnset >= this.#refractory
      ) {
        onsets.push(this.#windowStart);
        this.#lastOnset = this.#windowStart;
      }
      this.#recent.push(rms);
      if (this.#recent.length > this.#lookback) this.#recent.shift();
      this.#sum = 0;
      this.#count = 0;
    }
    return onsets;
  }
}
