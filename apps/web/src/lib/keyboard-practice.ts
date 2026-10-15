import { ALL_KEYS, degreeToMidi, tonicChroma, type Key, type StimulusSpec } from "@clavis/core";
import { DEFAULT_HIGH, DEFAULT_LOW } from "./keyboard";
import { orientSpec } from "./session/orient";

/** Middle C up to the B above it: where the home note and chord sound for practice. */
const BASE_MIDI = 60;

export type GuideMark = "tonic" | "chord";

/** The tonic and the notes of the home chord (1, 3, 5) in the key, from middle C upwards. */
export function homeNotes(key: Key): { tonic: number; chord: number[] } {
  const tonic = BASE_MIDI + tonicChroma(key);
  return { tonic, chord: [1, 3, 5].map((d) => degreeToMidi(key, d, tonic)) };
}

/** Phrase for the "home note" button. */
export function homeNoteSpec(key: Key): StimulusSpec {
  const { tonic } = homeNotes(key);
  return { events: [{ atSec: 0, midi: [tonic], durationSec: 1.6, velocity: 0.8 }] };
}

/** Phrase for the "home chord" button: 1, 3 and 5 together. */
export function homeChordSpec(key: Key): StimulusSpec {
  const { chord } = homeNotes(key);
  return { events: [{ atSec: 0, midi: chord, durationSec: 1.8, velocity: 0.75 }] };
}

/** Phrase for "hear the key": the scale, then the cadence, as the warm-up plays them. */
export function keySpec(key: Key): StimulusSpec {
  return orientSpec(key, true);
}

/** Every key on the visible range, marked by pitch class: the tonic strongly, the chord lightly. */
export function guideMarks(
  key: Key,
  low = DEFAULT_LOW,
  high = DEFAULT_HIGH,
): Record<number, GuideMark> {
  const { tonic, chord } = homeNotes(key);
  const marks: Record<number, GuideMark> = {};
  for (let midi = low; midi <= high; midi++) {
    if (midi % 12 === tonic % 12) marks[midi] = "tonic";
    else if (chord.some((c) => c % 12 === midi % 12)) marks[midi] = "chord";
  }
  return marks;
}

/** "G major" for the key picker. */
export function keyLabel(key: Key): string {
  return `${key.tonic} ${key.mode}`;
}

export const PRACTICE_KEYS: readonly Key[] = ALL_KEYS;
