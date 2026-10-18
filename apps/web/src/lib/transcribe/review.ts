import type { NoteEvent } from "@clavis/core";

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function noteName(midi: number): string {
  return `${NAMES[((midi % 12) + 12) % 12] ?? "?"}${String(Math.floor(midi / 12) - 1)}`;
}

/** Notes struck within this many ms of the group's first note read as one chord. */
export const CHORD_WINDOW_MS = 90;

export interface HeardChord {
  /** Seconds from the start of the take. */
  atSec: number;
  names: string[];
}

/**
 * Group transcribed notes into chords for reading on the review page (R31): the way a learner
 * compares "what I played" with "what the app heard". Notes must be sorted by onset.
 */
export function groupChords(notes: readonly NoteEvent[], startMs: number): HeardChord[] {
  const out: { first: number; pitches: number[] }[] = [];
  for (const n of notes) {
    const open = out[out.length - 1];
    if (open && n.onsetMs - open.first <= CHORD_WINDOW_MS) open.pitches.push(n.pitch);
    else out.push({ first: n.onsetMs, pitches: [n.pitch] });
  }
  return out.map((g) => ({
    atSec: (g.first - startMs) / 1000,
    names: [...g.pitches].sort((a, b) => a - b).map(noteName),
  }));
}
