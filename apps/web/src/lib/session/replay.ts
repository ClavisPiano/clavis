import type {
  ItemInstance,
  NoteEvent,
  PitchFrame,
  StimulusEvent,
  StimulusSpec,
} from "@clavis/core";
import { segmentSungNotes } from "@clavis/scoring";

/*
 * Replay (spec 8.5): the reference target followed by the learner's own attempt, both as piano
 * notes. The reference is the item's target notes (and count-in clicks for rhythm), without the
 * cadence. The attempt comes from played notes, or from sung segments converted to MIDI.
 */

export const REPLAY_GAP_SEC = 0.9;
const ATTEMPT_VELOCITY = 0.7;
const MAX_NOTE_SEC = 0.6;
const MIN_NOTE_SEC = 0.15;

export interface Attempt {
  notes: readonly NoteEvent[];
  frames: readonly PitchFrame[];
}

const TARGET_VELOCITY = 0.8;
const TARGET_NOTE_SEC = 0.8;
const TARGET_GAP_SEC = 0.6;
const RHYTHM_NOTE_SEC = 0.25;

/**
 * Reading items show their target and play no audio before the answer (R17), so the stimulus
 * holds no target. The reference is built from the expected response: the note, the notes one
 * after another, or the rhythm after its count-in.
 */
function displayTargetEvents(instance: ItemInstance): StimulusEvent[] {
  const play = instance.expected.play;
  const countIn = instance.stimulus.events.filter((e) => e.role === "count-in");
  switch (play?.kind) {
    case "exactPitch":
    case "pitchClass":
      return [
        {
          atSec: 0,
          midi: [play.targetMidi],
          durationSec: TARGET_NOTE_SEC,
          velocity: TARGET_VELOCITY,
          role: "target",
        },
      ];
    case "sequence":
      return play.midi.map((m, i) => ({
        atSec: i * TARGET_GAP_SEC,
        midi: [m],
        durationSec: TARGET_NOTE_SEC,
        velocity: TARGET_VELOCITY,
        role: "target" as const,
      }));
    case "rhythm": {
      const beatSec = 60 / play.tempoBpm;
      const countInEnd = countIn.reduce((end, e) => Math.max(end, e.atSec + beatSec), 0);
      return [
        ...countIn,
        ...play.onsetsBeats.map((b) => ({
          atSec: countInEnd + b * beatSec,
          midi: [play.pitch ?? 60],
          durationSec: RHYTHM_NOTE_SEC,
          velocity: TARGET_VELOCITY,
          role: "target" as const,
        })),
      ];
    }
    default:
      return [];
  }
}

function referenceEvents(instance: ItemInstance): StimulusEvent[] {
  const events = instance.display
    ? displayTargetEvents(instance)
    : instance.stimulus.events.filter((e) => e.role === "target" || e.role === "count-in");
  const start = events.reduce((min, e) => Math.min(min, e.atSec), Infinity);
  const shift = Number.isFinite(start) ? start : 0;
  return events.map((e) => ({ ...e, atSec: e.atSec - shift }));
}

/** Attempt notes as stimulus events starting at 0 (relative timing kept). */
export function attemptEvents(attempt: Attempt): StimulusEvent[] {
  const played = [...attempt.notes].sort((a, b) => a.onsetMs - b.onsetMs);
  const timed: { midi: number; startMs: number; endMs: number | undefined }[] =
    played.length > 0
      ? played.map((n) => ({ midi: n.pitch, startMs: n.onsetMs, endMs: n.offsetMs }))
      : segmentSungNotes(attempt.frames).map((s) => ({
          midi: Math.round(s.midi),
          startMs: s.startMs,
          endMs: s.endMs,
        }));
  const first = timed[0];
  if (!first) return [];
  return timed.map((n, i) => {
    const next = timed[i + 1];
    const natural = n.endMs !== undefined ? (n.endMs - n.startMs) / 1000 : MAX_NOTE_SEC;
    const gap = next ? (next.startMs - n.startMs) / 1000 : MAX_NOTE_SEC;
    const durationSec = Math.max(MIN_NOTE_SEC, Math.min(natural, gap * 0.95, MAX_NOTE_SEC));
    return {
      atSec: (n.startMs - first.startMs) / 1000,
      midi: [Math.min(127, Math.max(0, n.midi))],
      durationSec,
      velocity: ATTEMPT_VELOCITY,
    };
  });
}

/** Reference, a short gap, then the attempt. Empty attempts give the reference alone. */
export function buildReplaySpec(instance: ItemInstance, attempt: Attempt): StimulusSpec {
  const reference = referenceEvents(instance);
  const referenceEnd = reference.reduce((end, e) => Math.max(end, e.atSec + e.durationSec), 0);
  const mine = attemptEvents(attempt).map((e) => ({
    ...e,
    atSec: e.atSec + referenceEnd + REPLAY_GAP_SEC,
  }));
  return {
    events: [...reference, ...mine],
    ...(instance.stimulus.tempoBpm === undefined ? {} : { tempoBpm: instance.stimulus.tempoBpm }),
  };
}
