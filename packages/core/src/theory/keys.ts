import { chromaOf, majorSignature, minorSignature, transposeName } from "./tonal.js";

export type Mode = "major" | "minor";
/** Spelled pitch class such as "C", "F#", "Bb". Scale degree names may also carry double accidentals. */
export type PitchClassName = string;
/** MIDI note number (C4 = 60). */
export type Midi = number;
export interface VoiceRange {
  low: Midi;
  high: Midi;
}
export interface Key {
  tonic: PitchClassName;
  mode: Mode;
}
export type KeyFamily = "A" | "B" | "C";
export type MinorVariant = "natural" | "harmonic" | "melodic";

/**
 * Supported tonics per mode (spec 3.4). Only single accidentals and at most six
 * sharps or flats are accepted, so E#, Cb, C# major etc. are rejected.
 */
const MAJOR_TONICS = [
  "C",
  "G",
  "D",
  "A",
  "E",
  "B",
  "F#",
  "Gb",
  "Db",
  "Ab",
  "Eb",
  "Bb",
  "F",
] as const;
const MINOR_TONICS = [
  "A",
  "E",
  "B",
  "F#",
  "C#",
  "G#",
  "D#",
  "Eb",
  "Bb",
  "F",
  "C",
  "G",
  "D",
] as const;

/** Major keys in circle-of-fifths order (clockwise). F#/Gb is canonically F#. */
const CIRCLE_MAJOR = ["C", "G", "D", "A", "E", "B", "F#", "Db", "Ab", "Eb", "Bb", "F"] as const;
/** Minor keys in circle order. The d#/eb pair is canonically d#, matching F# as its relative major. */
const CIRCLE_MINOR = ["A", "E", "B", "F#", "C#", "G#", "D#", "Bb", "F", "C", "G", "D"] as const;

export function isValidKey(key: Key): boolean {
  const list: readonly string[] = key.mode === "major" ? MAJOR_TONICS : MINOR_TONICS;
  return list.includes(key.tonic);
}

function assertKey(key: Key): void {
  if (!isValidKey(key)) {
    throw new RangeError(`Unsupported ${key.mode} key tonic: ${JSON.stringify(key.tonic)}`);
  }
}

/** Build a validated key. Throws RangeError for unsupported tonic spellings (double accidentals, E#, ...). */
export function makeKey(tonic: PitchClassName, mode: Mode): Key {
  const key: Key = { tonic, mode };
  assertKey(key);
  return key;
}

/**
 * The 12 major keys then the 12 minor keys, each in circle-of-fifths order.
 * Canonical enharmonic spellings: F# major (alternative Gb) and D# minor (alternative Eb).
 */
export const ALL_KEYS: readonly Key[] = [
  ...CIRCLE_MAJOR.map((tonic): Key => ({ tonic, mode: "major" })),
  ...CIRCLE_MINOR.map((tonic): Key => ({ tonic, mode: "minor" })),
];

/**
 * The enharmonic alternative spelling of a key (F# <-> Gb major, D# <-> Eb minor), or
 * null when the key has none. Eb major is a different key from Eb minor and has no alternative.
 */
export function enharmonicKey(key: Key): Key | null {
  assertKey(key);
  if (key.mode === "major") {
    if (key.tonic === "F#") return { tonic: "Gb", mode: "major" };
    if (key.tonic === "Gb") return { tonic: "F#", mode: "major" };
    return null;
  }
  if (key.tonic === "D#") return { tonic: "Eb", mode: "minor" };
  if (key.tonic === "Eb") return { tonic: "D#", mode: "minor" };
  return null;
}

/** Canonical spelling of a key (see ALL_KEYS). */
export function canonicalKey(key: Key): Key {
  assertKey(key);
  if (key.mode === "major" && key.tonic === "Gb") return { tonic: "F#", mode: "major" };
  if (key.mode === "minor" && key.tonic === "Eb") return { tonic: "D#", mode: "minor" };
  return { tonic: key.tonic, mode: key.mode };
}

/** Pitch class (0..11, C = 0) of the key's tonic. */
export function tonicChroma(key: Key): number {
  assertKey(key);
  const c = chromaOf(key.tonic);
  if (c === null) throw new RangeError(`Bad tonic ${key.tonic}`);
  return c;
}

/** Signed number of accidentals in the key signature: sharps positive, flats negative. */
export function keySignatureAccidentals(key: Key): number {
  assertKey(key);
  return key.mode === "major" ? majorSignature(key.tonic) : minorSignature(key.tonic);
}

/** Key family per spec 3.4 (minor shares the family of its relative major). */
export function keyFamily(key: Key): KeyFamily {
  const n = Math.abs(keySignatureAccidentals(key));
  return n <= 1 ? "A" : n <= 3 ? "B" : "C";
}

export function relativeMajor(key: Key): Key {
  assertKey(key);
  if (key.mode === "major") return { ...key };
  return makeKey(transposeName(key.tonic, "3m"), "major");
}

export function relativeMinor(key: Key): Key {
  assertKey(key);
  if (key.mode === "minor") return { ...key };
  return makeKey(transposeName(key.tonic, "-3m"), "minor");
}

/**
 * Next key around the circle of fifths in the same mode. "sharp" (default) moves
 * clockwise (C to G), "flat" moves anticlockwise (C to F). Always returns the canonical spelling.
 */
export function circleOfFifthsNext(key: Key, direction: "sharp" | "flat" = "sharp"): Key {
  const k = canonicalKey(key);
  const circle: readonly string[] = k.mode === "major" ? CIRCLE_MAJOR : CIRCLE_MINOR;
  const next = circle[(circle.indexOf(k.tonic) + (direction === "sharp" ? 1 : 11)) % 12];
  if (next === undefined) throw new RangeError("unreachable");
  return { tonic: next, mode: k.mode };
}

/** All keys (both modes, canonical spellings) whose family is in `families`, in ALL_KEYS (circle) order. */
export function keysInFamilies(families: readonly KeyFamily[]): Key[] {
  return ALL_KEYS.filter((k) => families.includes(keyFamily(k)));
}
