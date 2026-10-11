import { keySignatureAccidentals, spelledToMidi, type ScoreSpec } from "@clavis/core";

/*
 * Note names for feedback on reading items ("You played E2. This note is D2."). Names are
 * scientific pitch (C4 = middle C). Notes written in the score keep their written spelling;
 * anything else is spelled with flats in a flat key and sharps otherwise.
 */

const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;
const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"] as const;

/** Name of a MIDI note such as "E2" or "Bb3". */
export function midiName(midi: number, preferFlats = false): string {
  const names = preferFlats ? FLAT_NAMES : SHARP_NAMES;
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return `${names[pc] ?? "?"}${String(octave)}`;
}

function writtenName(p: { step: string; alter: number; octave: number }): string {
  const acc = p.alter === 0 ? "" : p.alter > 0 ? "#".repeat(p.alter) : "b".repeat(-p.alter);
  return `${p.step}${acc}${String(p.octave)}`;
}

/** A function from MIDI to a note name, preferring the score's own spellings. */
export function noteNamer(score: ScoreSpec | undefined): (midi: number) => string {
  const written = new Map<number, string>();
  let flats = false;
  if (score) {
    for (const staff of score.staves)
      for (const measure of staff.measures)
        for (const el of measure)
          if (el.kind === "note")
            for (const p of el.pitches) {
              const m = spelledToMidi(p);
              if (!written.has(m)) written.set(m, writtenName(p));
            }
    if (score.key) {
      try {
        flats = keySignatureAccidentals(score.key) < 0;
      } catch {
        // An unsupported key spelling: fall back to sharps.
        flats = false;
      }
    }
  }
  return (midi) => written.get(midi) ?? midiName(midi, flats);
}
