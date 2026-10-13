import type { VoiceRange } from "../theory/keys.js";
import { makeNoteRead } from "./note-read.js";

/** Default treble reading range, middle C up to the A above the staff (C4..A5). */
export const TREBLE_READ_RANGE: VoiceRange = { low: 60, high: 81 };
/** Landmark notes: middle C, the G the clef curls round, and the C an octave above middle C. */
export const TREBLE_LANDMARKS: readonly string[] = ["C4", "G4", "C5"];

/**
 * Read a note on the treble staff and play it (TP.2). The same rules as `bassNoteRead` (R15, R17):
 * key families, exact octave, no audio preview. Serves read.treble.landmarks, .steps and .skips.
 */
export const trebleNoteRead = makeNoteRead({
  id: "trebleNoteRead",
  clef: "treble",
  low: "C4",
  high: "A5",
  readRange: TREBLE_READ_RANGE,
  landmarks: TREBLE_LANDMARKS,
});
