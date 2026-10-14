import type { VoiceRange } from "../theory/keys.js";
import { makeNoteRead, NOTE_INTERVAL_WINDOW_MS, NOTE_READ_WINDOW_MS } from "./note-read.js";

/** Default bass reading range, C2..E4. */
export const BASS_READ_RANGE: VoiceRange = { low: 36, high: 64 };
/** Landmark notes the interval variant starts from (the same four as read.bass.landmarks). */
export const BASS_LANDMARKS: readonly string[] = ["C2", "F3", "C4", "G2"];

export const BASS_NOTE_WINDOW_MS = NOTE_READ_WINDOW_MS;
export const BASS_INTERVAL_WINDOW_MS = NOTE_INTERVAL_WINDOW_MS;

/**
 * Read a note (or, for read.bass.intervals, two notes) on the bass staff and play it (R15, R17,
 * R18). No audio preview.
 */
export const bassNoteRead = makeNoteRead({
  id: "bassNoteRead",
  clef: "bass",
  low: "C2",
  high: "E4",
  readRange: BASS_READ_RANGE,
  landmarks: BASS_LANDMARKS,
});
