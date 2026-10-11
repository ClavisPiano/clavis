import {
  spelledToMidi,
  type SpelledPitch,
  type Step,
  type WrittenAccidental,
} from "../score/schema.js";
import { keySignatureAccidentals, type Key, type Midi, type VoiceRange } from "./keys.js";

/*
 * Staff theory: where a note sits on the staff versus what sounds, given the key signature.
 * Pure functions over the T3.1 score types. Item ids use the string form ("F3", R15), so a
 * parser and formatter are provided next to the object form used in code.
 */

/**
 * A line or space on the staff: a letter and an octave, with no accidental. The accidental
 * comes from the key signature (see positionInKey). Octave numbering is scientific (C4 = middle C).
 * String form: letter then octave, for example "F3" (see formatStaffPosition).
 */
export interface StaffPosition {
  step: Step;
  octave: number;
}

const STEPS: readonly Step[] = ["C", "D", "E", "F", "G", "A", "B"];
/** Order in which sharps (and, reversed, flats) join a key signature. */
const SHARP_ORDER: readonly Step[] = ["F", "C", "G", "D", "A", "E", "B"];
const FLAT_ORDER: readonly Step[] = ["B", "E", "A", "D", "G", "C", "F"];

function stepIndex(step: Step): number {
  return STEPS.indexOf(step);
}

/** Format a position as its item id form, for example `{ step: "F", octave: 3 }` to "F3". */
export function formatStaffPosition(pos: StaffPosition): string {
  return pos.step + String(pos.octave);
}

/** Parse "F3" style text. Throws RangeError when it is not a letter A-G followed by an integer octave. */
export function parseStaffPosition(text: string): StaffPosition {
  const m = /^([A-G])(-?[0-9]+)$/.exec(text);
  const letter = m?.[1];
  const octave = m?.[2];
  const step = STEPS.find((s) => s === letter);
  if (step === undefined || octave === undefined) {
    throw new RangeError(`Bad staff position: ${JSON.stringify(text)}`);
  }
  return { step, octave: Number(octave) };
}

/** Diatonic index of a position: C0 = 0, each letter step adds 1, each octave adds 7. */
export function staffPosition(pos: StaffPosition): number {
  return pos.octave * 7 + stepIndex(pos.step);
}

/** Inverse of staffPosition. */
export function positionFromIndex(index: number): StaffPosition {
  const octave = Math.floor(index / 7);
  const step = STEPS[index - octave * 7];
  if (step === undefined) throw new RangeError(`Bad staff index ${String(index)}`);
  return { step, octave };
}

/** The position `n` diatonic steps away (negative is lower). */
export function stepOffset(pos: StaffPosition, n: number): StaffPosition {
  return positionFromIndex(staffPosition(pos) + n);
}

/** Semitone alteration the key signature gives to a letter: +1, -1 or 0. */
function signatureAlter(key: Key, step: Step): number {
  const n = keySignatureAccidentals(key);
  if (n > 0) return SHARP_ORDER.slice(0, n).includes(step) ? 1 : 0;
  if (n < 0) return FLAT_ORDER.slice(0, -n).includes(step) ? -1 : 0;
  return 0;
}

export interface PositionInKeyOptions {
  /**
   * Minor keys only: request the raised 6th or 7th degree (melodic or harmonic minor accidentals).
   * The raise applies when the position's letter is that degree's letter in the key; for any other
   * letter, or in a major key, it is ignored. The signature of a minor key is always the natural
   * minor (relative major) signature, so a raised degree sounds one semitone above the signature.
   */
  raise?: 6 | 7;
}

function isRaisedDegree(pos: StaffPosition, key: Key, raise: 6 | 7): boolean {
  if (key.mode !== "minor") return false;
  const tonicIndex = STEPS.findIndex((s) => s === key.tonic.charAt(0));
  return stepIndex(pos.step) === (tonicIndex + raise - 1) % 7;
}

/**
 * The sounding pitch at a staff position with the key signature applied (and, optionally, a raised
 * minor degree). F3 in G major is F#3 (54), B2 in F major is Bb2 (46), C4 in D major is C#4 (61).
 */
export function positionInKey(
  pos: StaffPosition,
  key: Key,
  opts: PositionInKeyOptions = {},
): { pitch: SpelledPitch; midi: Midi } {
  let alter = signatureAlter(key, pos.step);
  if (opts.raise !== undefined && isRaisedDegree(pos, key, opts.raise)) alter += 1;
  const pitch: SpelledPitch = { step: pos.step, alter, octave: pos.octave };
  return { pitch, midi: spelledToMidi(pitch) };
}

/**
 * The accidental to write before a note so it sounds as `pitch` in `key`, or undefined when the key
 * signature already implies it. A natural is written when the signature alters that letter but the
 * pitch does not (G minor raised 6th E natural). Accidentals earlier in the bar are not considered:
 * visual items show one note per accidental decision.
 */
export function writtenAccidental(pitch: SpelledPitch, key: Key): WrittenAccidental | undefined {
  if (pitch.alter === signatureAlter(key, pitch.step)) return undefined;
  switch (pitch.alter) {
    case 0:
      return "natural";
    case 1:
      return "sharp";
    case -1:
      return "flat";
    case 2:
      return "double-sharp";
    default:
      return "double-flat";
  }
}

/** Every position from `low` to `high` inclusive, ascending. Empty when `low` is above `high`. */
export function positionsInRange(low: StaffPosition, high: StaffPosition): StaffPosition[] {
  const out: StaffPosition[] = [];
  for (let i = staffPosition(low); i <= staffPosition(high); i++) out.push(positionFromIndex(i));
  return out;
}

/**
 * Positions whose sounding pitch in `key` lies within the MIDI range (inclusive), ascending. Useful
 * for filtering by an item's inputRange.
 */
export function positionsInMidiRange(
  range: VoiceRange,
  key: Key,
  opts: PositionInKeyOptions = {},
): StaffPosition[] {
  // Alterations move a note by at most two semitones, so widening by one octave each side is enough.
  const lowOctave = Math.floor(range.low / 12) - 2;
  const highOctave = Math.floor(range.high / 12);
  return positionsInRange(
    { step: "C", octave: lowOctave },
    { step: "B", octave: highOctave },
  ).filter((p) => {
    const { midi } = positionInKey(p, key, opts);
    return midi >= range.low && midi <= range.high;
  });
}
