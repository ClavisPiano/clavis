import type { Phrase, ScoreSpec, SpelledPitch } from "@clavis/core";

/*
 * Phrase splitting and difficulty estimation for imported scores (T7.3). Both are pure and work on
 * the first staff, which is the only one an imported score has.
 */

type Element = ScoreSpec["staves"][number]["measures"][number][number];

/** Length of a whole note in the unit used to total durations (64ths). */
const WHOLE = 64;

const STEP_SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 } as const;

function midiOf(p: SpelledPitch): number {
  return (p.octave + 1) * 12 + STEP_SEMITONES[p.step] + p.alter;
}

function units(el: Element): number {
  const base = WHOLE / el.duration.value;
  return el.duration.dots === 1 ? base * 1.5 : base;
}

/** A measure end that reads as a pause: a rest, or a half note or longer that is not tied onward. */
function endsPhrase(measure: readonly Element[]): boolean {
  const last = measure[measure.length - 1];
  if (last === undefined) return false;
  if (last.kind === "rest") return true;
  const tie = last.duration.tie;
  if (tie === "start" || tie === "continue") return false;
  return last.duration.value <= 2;
}

/**
 * Splits a score into phrases, as measure ranges counted from 1 (the shape of a Piece phrase).
 *
 * From each phrase start the split prefers 4 measures when the fourth ends on a rest or a long
 * note, then 2 measures when the second does, and falls back to 2 measures otherwise. A single
 * measure left over joins the phrase before it, so the ranges tile the score exactly. An empty
 * score has no phrases.
 */
export function splitPhrases(score: ScoreSpec): Phrase[] {
  const measures = score.staves[0]?.measures ?? [];
  const count = measures.length;
  const good = (m: number): boolean => endsPhrase(measures[m - 1] ?? []);
  const phrases: Phrase[] = [];
  let start = 1;
  while (start <= count) {
    const remaining = count - start + 1;
    let length: number;
    if (remaining <= 3) length = remaining;
    else if (good(start + 3)) length = 4;
    else length = 2;
    if (remaining - length === 1) length += 1;
    phrases.push({ firstMeasure: start, lastMeasure: start + length - 1 });
    start += length;
  }
  return phrases;
}

export interface DifficultyFeatures {
  /** Highest minus lowest sounding pitch, in semitones. */
  rangeSemitones: number;
  /** Pitches sounded per quarter note of music (rests count as time). */
  density: number;
  /** Written accidentals per measure. */
  accidentalsPerMeasure: number;
  /** Sharps or flats in the key signature. */
  signatureSize: number;
  /** Distinct note values (with dots) plus one if any tie is used. */
  rhythmVariety: number;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

const MAJOR_FIFTHS: Record<string, number> = { F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5 };

function signatureSize(key: ScoreSpec["key"]): number {
  if (key === null) return 0;
  const m = /^([A-G])(#{0,2}|b{0,2})$/.exec(key.tonic);
  const base = m?.[1] === undefined ? undefined : MAJOR_FIFTHS[m[1]];
  if (m === null || base === undefined) return 0;
  const acc = m[2] ?? "";
  const alteration = acc.startsWith("#") ? acc.length : -acc.length;
  return Math.abs(base + 7 * alteration - (key.mode === "minor" ? 3 : 0));
}

export function difficultyFeatures(score: ScoreSpec): DifficultyFeatures {
  const measures = score.staves[0]?.measures ?? [];
  const elements = measures.flat();
  let lowest = Infinity;
  let highest = -Infinity;
  let pitchCount = 0;
  let accidentals = 0;
  let total = 0;
  let tied = false;
  const shapes = new Set<string>();
  for (const el of elements) {
    total += units(el);
    shapes.add(`${String(el.duration.value)}.${String(el.duration.dots)}`);
    if (el.duration.tie !== undefined) tied = true;
    if (el.kind !== "note") continue;
    if (el.accidental !== undefined) accidentals++;
    for (const p of el.pitches) {
      const midi = midiOf(p);
      lowest = Math.min(lowest, midi);
      highest = Math.max(highest, midi);
      pitchCount++;
    }
  }
  const quarters = total / (WHOLE / 4);
  return {
    rangeSemitones: pitchCount === 0 ? 0 : highest - lowest,
    density: quarters === 0 ? 0 : pitchCount / quarters,
    accidentalsPerMeasure: measures.length === 0 ? 0 : accidentals / measures.length,
    signatureSize: signatureSize(score.key),
    rhythmVariety: shapes.size + (tied ? 1 : 0),
  };
}

/**
 * Difficulty on the Piece scale, 1 (easiest) to 10, from range, note density, accidentals (written
 * ones and the key signature) and rhythm variety. Each feature is clamped to a band and the
 * weighted sum is spread over 1 to 10, so each feature can only raise the result.
 */
export function estimateDifficulty(score: ScoreSpec): number {
  const f = difficultyFeatures(score);
  const x =
    0.3 * clamp01((f.rangeSemitones - 4) / 20) +
    0.25 * clamp01((f.density - 0.5) / 3) +
    0.15 * clamp01(f.accidentalsPerMeasure / 1.5) +
    0.05 * clamp01(f.signatureSize / 5) +
    0.25 * clamp01((f.rhythmVariety - 1) / 5);
  return Math.min(10, Math.max(1, 1 + Math.round(9 * x)));
}
