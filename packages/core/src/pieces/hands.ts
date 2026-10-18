import { LH_RANGE, chordSymbol, lhChords } from "../items/lh-pattern.js";
import {
  spelledToMidi,
  type ScoreSpec,
  type SpelledPitch,
  type StaffSpec,
} from "../score/schema.js";
import { isValidKey, type Key } from "../theory/keys.js";
import { chromaOf } from "../theory/tonal.js";
import type { Piece } from "./schema.js";
import { isHandsPiece } from "./schema.js";

/*
 * Hands-together pieces (T5.6): the left hand's block chords under a library melody. These helpers
 * read the chords back from the bass staff, so the content is the score alone, and check that the
 * chords fit the tune (`handsFitErrors`, run by `validatePieces`).
 */

/** The chords a hands-together piece may use: root-position major triads on these degrees. */
const ROMAN_BY_SEMITONES: Readonly<Record<number, string>> = { 0: "I", 5: "IV", 7: "V" };

/** One chord of the left hand. */
export interface HandsChord {
  /** The measure it starts in, from 0. */
  measure: number;
  /** Beats (of the meter's beat value) from the start of the score. */
  onsetBeats: number;
  durationBeats: number;
  pitches: SpelledPitch[];
  midi: number[];
  /** "I", "IV" or "V" for a root-position triad on those degrees of the key, else undefined. */
  roman: string | undefined;
  /** "C", "F", "G": the root's letter, for the label beside the staff. */
  symbol: string;
}

function beatsOf(el: { duration: { value: number; dots: number } }, beatValue: number): number {
  return (beatValue / el.duration.value) * (el.duration.dots === 1 ? 1.5 : 1);
}

/** Root position major triad on I, IV or V of `key`, by its tones. */
function romanOf(midi: readonly number[], key: { tonic: string }): string | undefined {
  const sorted = [...midi].sort((a, b) => a - b);
  const [root, third, fifth] = sorted;
  if (sorted.length !== 3 || root === undefined || third === undefined || fifth === undefined) {
    return undefined;
  }
  if (third - root !== 4 || fifth - root !== 7) return undefined;
  const tonic = chromaOf(key.tonic);
  if (tonic === null) return undefined;
  return ROMAN_BY_SEMITONES[(((root - tonic) % 12) + 12) % 12];
}

/** The chords of the bass staff of `score`, in order. Empty when it has no second staff. */
export function handsChords(score: ScoreSpec): HandsChord[] {
  const bass = score.staves[1];
  const key = score.key ?? { tonic: "C" };
  const beatValue = score.meter?.beatValue ?? 4;
  const out: HandsChord[] = [];
  let t = 0;
  bass?.measures.forEach((measure, m) => {
    for (const el of measure) {
      const beats = beatsOf(el, beatValue);
      if (el.kind === "note") {
        const midi = el.pitches.map(spelledToMidi);
        const lowest = el.pitches[midi.indexOf(Math.min(...midi))];
        out.push({
          measure: m,
          onsetBeats: t,
          durationBeats: beats,
          pitches: el.pitches,
          midi,
          roman: romanOf(midi, key),
          symbol: lowest === undefined ? "" : chordSymbol(lowest, false),
        });
      }
      t += beats;
    }
  });
  return out;
}

/** The sounding notes of one staff, from the start of the score: a tie lengthens a note. */
function soundingNotes(
  staff: StaffSpec,
  beatValue: number,
): { midi: number; onsetBeats: number; durationBeats: number }[] {
  const out: { midi: number; onsetBeats: number; durationBeats: number }[] = [];
  let t = 0;
  for (const measure of staff.measures) {
    for (const el of measure) {
      const beats = beatsOf(el, beatValue);
      const pitch = el.kind === "note" ? el.pitches[0] : undefined;
      const tiedOn = el.duration.tie === "stop" || el.duration.tie === "continue";
      const last = out[out.length - 1];
      if (pitch !== undefined && tiedOn && last !== undefined) last.durationBeats += beats;
      else if (pitch !== undefined) {
        out.push({ midi: spelledToMidi(pitch), onsetBeats: t, durationBeats: beats });
      }
      t += beats;
    }
  }
  return out;
}

const NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

/**
 * Why the left hand of a hands-together piece does not fit its melody. Empty when it does, and for
 * a one-hand piece. The rules, each checked chord by chord:
 *
 * - Every chord is a root-position major triad on I, IV or V of the key, every tone in C2 to C4.
 * - A chord starts on the first beat or the middle of a bar and lasts a whole or a half bar, and
 *   the left hand never rests.
 * - Voicing: each root is the one nearest the root before it, as `lhChords` voices the same
 *   numerals (the `lhPattern` rule), so the hand moves as little as possible.
 * - Fit: the melody note sounding at the chord's onset is one of its pitch classes. The one
 *   exception is the tonic chord at a cadence: I as the last chord of a phrase may sound under any
 *   note.
 * - The piece ends on I.
 */
export function handsFitErrors(piece: Piece): string[] {
  if (!isHandsPiece(piece)) return [];
  const { score } = piece;
  const treble = score.staves[0];
  const bass = score.staves[1];
  if (treble === undefined || bass === undefined || score.meter === null || score.key === null) {
    return [`${piece.id}: a hands-together piece needs two staves, a key and a meter`];
  }
  const errors: string[] = [];
  const beatValue = score.meter.beatValue;
  const barBeats = score.meter.beats;
  const melody = soundingNotes(treble, beatValue);
  const chords = handsChords(score);

  bass.measures.forEach((measure, m) => {
    if (measure.some((el) => el.kind === "rest")) {
      errors.push(`${piece.id}: bar ${String(m + 1)}: the left hand rests`);
    }
  });

  // The last chord of each phrase, where the tonic may sound under any melody note.
  const cadences = new Set<HandsChord>();
  for (const phrase of piece.phrases) {
    const inPhrase = chords.filter(
      (c) => c.measure + 1 >= phrase.firstMeasure && c.measure + 1 <= phrase.lastMeasure,
    );
    const last = inPhrase[inPhrase.length - 1];
    if (last !== undefined) cadences.add(last);
  }

  for (const c of chords) {
    const beatInBar = c.onsetBeats - c.measure * barBeats;
    const where = `${piece.id}: bar ${String(c.measure + 1)} beat ${String(beatInBar + 1)}`;
    if (c.roman === undefined) {
      errors.push(`${where}: not a root-position I, IV or V chord`);
      continue;
    }
    if (beatInBar !== 0 && beatInBar !== barBeats / 2) {
      errors.push(`${where}: a chord starts on the first beat or the middle of the bar`);
    }
    if (c.durationBeats !== barBeats && c.durationBeats !== barBeats / 2) {
      errors.push(`${where}: a chord lasts a whole or a half bar`);
    }
    if (c.midi.some((x) => x < LH_RANGE.low || x > LH_RANGE.high)) {
      errors.push(`${where}: ${c.symbol} goes outside C2 to C4`);
    }
    const note = melody.find(
      (n) => n.onsetBeats <= c.onsetBeats && c.onsetBeats < n.onsetBeats + n.durationBeats,
    );
    const shares = note !== undefined && c.midi.some((x) => (x - note.midi) % 12 === 0);
    const cadence = c.roman === "I" && cadences.has(c);
    if (!shares && !cadence) {
      const heard = note === undefined ? "a rest" : `the melody's ${NAMES[note.midi % 12] ?? "?"}`;
      errors.push(`${where}: ${c.roman} (${c.symbol}) shares no note with ${heard}`);
    }
  }
  const last = chords[chords.length - 1];
  if (last !== undefined && last.roman !== "I") {
    errors.push(`${piece.id}: the last chord is ${last.roman ?? last.symbol}, not I`);
  }

  // Voicing: the same numerals as `lhChords` voices them.
  const romans = chords.map((c) => c.roman);
  const key: Key = { tonic: score.key.tonic, mode: score.key.mode };
  if (romans.every((r) => r !== undefined) && isValidKey(key) && key.mode === "major") {
    const voiced = lhChords(key, romans);
    chords.forEach((c, i) => {
      const want = voiced[i]?.midi ?? [];
      const have = [...c.midi].sort((a, b) => a - b);
      if (want.join() !== have.join()) {
        errors.push(
          `${piece.id}: bar ${String(c.measure + 1)}: ${c.roman ?? ""} is not voiced with the root nearest the one before`,
        );
      }
    });
  }
  return errors;
}
