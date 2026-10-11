import {
  type Key,
  type Midi,
  type MinorVariant,
  type PitchClassName,
  type VoiceRange,
  tonicChroma,
} from "./keys.js";
import { transposeName } from "./tonal.js";

/**
 * Register and degree conventions
 *
 * - A register is expressed as `tonicMidi`: the MIDI note of degree 1 in the target octave.
 *   Its pitch class must equal the key's tonic (use `tonicMidiAt`); functions throw otherwise.
 * - Degrees are integers. 1..7 are the scale degrees of the octave starting at `tonicMidi`;
 *   8 is the tonic an octave up, 0 is degree 7 one octave below, -6 is the tonic an octave below.
 * - Minor keys use the natural minor by default (the tonic is its own home, degree 1 with b3).
 *   `minorVariant` selects harmonic (raised 7) or melodic (ascending: raised 6 and 7).
 * - A chromatic note is described as a scale degree plus `alteration` of -1 or +1 semitones.
 */

export interface DegreeOptions {
  minorVariant?: MinorVariant;
}
export type DegreeAlteration = -1 | 0 | 1;
export interface DegreeInfo {
  degree: number;
  alteration: DegreeAlteration;
}

const MAJOR_SEMIS = [0, 2, 4, 5, 7, 9, 11] as const;
const MINOR_SEMIS: Record<MinorVariant, readonly number[]> = {
  natural: [0, 2, 3, 5, 7, 8, 10],
  harmonic: [0, 2, 3, 5, 7, 8, 11],
  melodic: [0, 2, 3, 5, 7, 9, 11],
};
const MAJOR_INTERVALS = ["1P", "2M", "3M", "4P", "5P", "6M", "7M"] as const;
const MINOR_INTERVALS: Record<MinorVariant, readonly string[]> = {
  natural: ["1P", "2M", "3m", "4P", "5P", "6m", "7m"],
  harmonic: ["1P", "2M", "3m", "4P", "5P", "6m", "7M"],
  melodic: ["1P", "2M", "3m", "4P", "5P", "6M", "7M"],
};

/** Semitone offsets from the tonic for degrees 1..7 of the key's scale. */
export function scaleSemitones(key: Key, opts?: DegreeOptions): readonly number[] {
  return key.mode === "major" ? MAJOR_SEMIS : MINOR_SEMIS[opts?.minorVariant ?? "natural"];
}

const mod = (n: number, m: number): number => ((n % m) + m) % m;

function assertDegree(degree: number): void {
  if (!Number.isInteger(degree))
    throw new RangeError(`Degree must be an integer: ${String(degree)}`);
}

/** MIDI of the key's tonic in the given scientific octave (C4 = 60). */
export function tonicMidiAt(key: Key, octave: number): Midi {
  return (octave + 1) * 12 + tonicChroma(key);
}

function assertTonicMidi(key: Key, tonicMidi: Midi): void {
  if (!Number.isInteger(tonicMidi) || mod(tonicMidi, 12) !== tonicChroma(key)) {
    throw new RangeError(`tonicMidi ${String(tonicMidi)} is not a ${key.tonic}`);
  }
}

/** Spelled pitch class of a degree (any integer; octave is ignored). */
export function degreeToPitchClass(key: Key, degree: number, opts?: DegreeOptions): PitchClassName {
  assertDegree(degree);
  tonicChroma(key); // validates key
  const intervals =
    key.mode === "major" ? MAJOR_INTERVALS : MINOR_INTERVALS[opts?.minorVariant ?? "natural"];
  const interval = intervals[mod(degree - 1, 7)];
  if (interval === undefined) throw new RangeError("unreachable");
  return transposeName(key.tonic, interval);
}

/** MIDI note of `degree` (optionally altered by -1/+1 semitone) relative to `tonicMidi`. */
export function degreeToMidi(
  key: Key,
  degree: number,
  tonicMidi: Midi,
  opts?: DegreeOptions & { alteration?: DegreeAlteration },
): Midi {
  assertDegree(degree);
  assertTonicMidi(key, tonicMidi);
  const idx = degree - 1;
  const s = scaleSemitones(key, opts)[mod(idx, 7)];
  if (s === undefined) throw new RangeError("unreachable");
  return tonicMidi + Math.floor(idx / 7) * 12 + s + (opts?.alteration ?? 0);
}

/**
 * Describe `midi` as a degree of the key relative to `tonicMidi`. Scale notes give alteration 0.
 * Chromatic notes are flat of the next degree up (alteration -1), except where that degree is
 * a tonic or fifth (which would give b1 or b5); there they are sharp of the degree below (+1),
 * e.g. #4, and the raised leading tone #7 in natural minor. Total: every MIDI note maps to a
 * result, and `degreeToMidi` with the returned alteration gives the note back.
 */
export function midiToDegree(
  key: Key,
  midi: Midi,
  tonicMidi: Midi,
  opts?: DegreeOptions,
): DegreeInfo {
  assertTonicMidi(key, tonicMidi);
  if (!Number.isInteger(midi)) throw new RangeError(`midi must be an integer: ${String(midi)}`);
  const rel = midi - tonicMidi;
  const octave = Math.floor(rel / 12);
  const r = mod(rel, 12);
  const semis = scaleSemitones(key, opts);
  const exact = semis.indexOf(r);
  if (exact >= 0) return { degree: octave * 7 + exact + 1, alteration: 0 };
  const up = semis.findIndex((x) => x > r);
  const upperIdx = up < 0 ? 7 : up;
  const upperDegree = octave * 7 + upperIdx + 1;
  const inOctave = upperIdx % 7;
  const upperSemis = up < 0 ? 12 : (semis[up] ?? 12);
  if (upperSemis - 1 === r && inOctave !== 0 && inOctave !== 4) {
    return { degree: upperDegree, alteration: -1 };
  }
  // Sharp of the degree below. Also covers the augmented second of harmonic minor.
  return { degree: upperDegree - 1, alteration: 1 };
}

/** One octave ascending from the tonic including the octave tonic (8 notes). Minor uses `minorVariant` (default natural). */
export function scaleMidi(key: Key, tonicMidi: Midi, opts?: DegreeOptions): Midi[] {
  return [1, 2, 3, 4, 5, 6, 7, 8].map((d) => degreeToMidi(key, d, tonicMidi, opts));
}

export interface TonicFit {
  tonicMidi: Midi;
  fits: boolean;
}

/**
 * Choose the tonic octave so degrees `span.low..span.high` fit in `range`. Among fitting
 * octaves the one closest to the centre of the range wins (ties go lower). If none fits,
 * returns the octave with the least total overflow (ties go lower) and `fits: false`.
 */
export function tonicMidiForRange(
  key: Key,
  range: VoiceRange,
  span: { low: number; high: number } = { low: 1, high: 8 },
  opts?: DegreeOptions,
): TonicFit {
  if (range.low > range.high) throw new RangeError("range.low must not exceed range.high");
  const c = tonicChroma(key);
  const centre = (range.low + range.high) / 2;
  let best: { tonicMidi: Midi; over: number; dist: number } | null = null;
  for (let t = Math.floor((range.low - 48 - c) / 12) * 12 + c; t <= range.high + 48; t += 12) {
    const lo = degreeToMidi(key, span.low, t, opts);
    const hi = degreeToMidi(key, span.high, t, opts);
    const over = Math.max(0, range.low - lo) + Math.max(0, hi - range.high);
    const dist = Math.abs((lo + hi) / 2 - centre);
    if (best === null || over < best.over || (over === best.over && dist < best.dist)) {
      best = { tonicMidi: t, over, dist };
    }
  }
  if (best === null) throw new RangeError("unreachable");
  return { tonicMidi: best.tonicMidi, fits: best.over === 0 };
}
