import type { NoteEvent } from "@clavis/core";
import type { TranscribedNote } from "./types.js";

export interface ToNoteEventsOptions {
  /** AudioContext time of the take's first sample, in ms. */
  startMs: number;
  /** Notes weaker than this are dropped as model noise. Default 0.5: real notes score 0.75 and up, overtone ghosts 0.3 to 0.4. */
  minAmplitude?: number;
}

export const DEFAULT_MIN_AMPLITUDE = 0.5;

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/**
 * Turn transcribed notes into the `NoteEvent`s the session scores, on the AudioContext clock and
 * sorted by onset. Notes outside the MIDI range or below `minAmplitude` are dropped.
 */
export function toNoteEvents(
  notes: readonly TranscribedNote[],
  options: ToNoteEventsOptions,
): NoteEvent[] {
  const min = options.minAmplitude ?? DEFAULT_MIN_AMPLITUDE;
  return notes
    .filter((n) => Number.isInteger(n.midi) && n.midi >= 0 && n.midi <= 127 && n.amplitude >= min)
    .map((n) => {
      const onsetMs = options.startMs + n.startSec * 1000;
      return {
        pitch: n.midi,
        onsetMs,
        offsetMs: onsetMs + n.durationSec * 1000,
        velocity: Math.round(clamp01(n.amplitude) * 127),
        confidence: clamp01(n.amplitude),
        source: "mic" as const,
      };
    })
    .sort((a, b) => a.onsetMs - b.onsetMs || a.pitch - b.pitch);
}
