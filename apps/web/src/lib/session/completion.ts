import type { NoteEvent, PitchFrame, PlayTarget, SingTarget } from "@clavis/core";
import { findStableSegments, segmentSungNotes } from "@clavis/scoring";

/*
 * Response completion: when has the learner finished answering? The listening phase also ends at
 * the response window and on a Done or Skip tap, which the machine handles. These checks are pure:
 * they look only at what was collected so far and the current time on the same clock.
 */

/** A sequence is done when enough notes arrived and the player went quiet for this long. */
export const SEQUENCE_QUIET_MS = 800;
/** A sung sequence is done when enough notes were sung and the voice stopped for this long. */
export const SUNG_QUIET_MS = 300;
/**
 * A chord line with some tones still to come is given up on after this much silence. Longer than
 * a chord is held at the slow tempo, so a learner working out the next chord is not cut off.
 */
export const CHORD_GIVE_UP_MS = 5000;
/** A single played note is abandoned after this many wrong notes. */
export const MAX_WRONG_NOTES = 3;

export interface DoneCheck {
  done: boolean;
  /** When not done but a time-based condition is pending: re-check after this many ms. */
  recheckInMs?: number;
}

const NOT_DONE: DoneCheck = { done: false };

const pc = (midi: number): number => ((midi % 12) + 12) % 12;

function quiet(lastMs: number, nowMs: number, quietMs: number): DoneCheck {
  const left = lastMs + quietMs - nowMs;
  return left <= 0 ? { done: true } : { done: false, recheckInMs: Math.ceil(left) };
}

/** Played (or tapped) response. `notes` must already be limited to this phase. */
export function checkPlayDone(
  target: PlayTarget,
  notes: readonly NoteEvent[],
  nowMs: number,
): DoneCheck {
  const sorted = [...notes].sort((a, b) => a.onsetMs - b.onsetMs);
  const last = sorted[sorted.length - 1];
  switch (target.kind) {
    case "pitchClass": {
      const want = pc(target.targetMidi);
      if (sorted.some((n) => pc(n.pitch) === want)) return { done: true };
      return sorted.length >= MAX_WRONG_NOTES ? { done: true } : NOT_DONE;
    }
    case "exactPitch": {
      if (sorted.some((n) => n.pitch === target.targetMidi)) return { done: true };
      return sorted.length >= MAX_WRONG_NOTES ? { done: true } : NOT_DONE;
    }
    case "sequence":
    case "line":
      if (!last || sorted.length < target.midi.length) return NOT_DONE;
      return quiet(last.onsetMs, nowMs, SEQUENCE_QUIET_MS);
    case "chordLine": {
      // Every tone struck and the hand lifted, or a long pause with some still missing.
      if (!last) return NOT_DONE;
      const total = target.chords.reduce((n, c) => n + c.midi.length, 0);
      return quiet(
        last.onsetMs,
        nowMs,
        sorted.length >= total ? SEQUENCE_QUIET_MS : CHORD_GIVE_UP_MS,
      );
    }
    case "rhythm": {
      if (!last || sorted.length < target.onsetsBeats.length) return NOT_DONE;
      return quiet(last.onsetMs, nowMs, 60000 / target.tempoBpm);
    }
    case "choice":
      // Ended by the learner picking a button, or by the response window.
      return NOT_DONE;
  }
}

/** Sung response. `frames` must already be limited to this phase. */
export function checkSingDone(
  target: SingTarget,
  frames: readonly PitchFrame[],
  nowMs: number,
): DoneCheck {
  if (target.kind === "sungPitch") {
    return findStableSegments(frames).length > 0 ? { done: true } : NOT_DONE;
  }
  const segments = segmentSungNotes(frames);
  const last = segments[segments.length - 1];
  if (!last || segments.length < target.midi.length) return NOT_DONE;
  return quiet(last.endMs, nowMs, SUNG_QUIET_MS);
}
