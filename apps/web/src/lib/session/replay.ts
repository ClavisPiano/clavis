import type { ItemInstance, NoteEvent, StimulusEvent, StimulusSpec } from "@clavis/core";

/*
 * Replay (spec 8.5): the reference target followed by the learner's own attempt, both as piano
 * notes. The reference is the item's target notes (and count-in clicks for rhythm), without the
 * cadence. The attempt is the learner's played notes.
 */

export const REPLAY_GAP_SEC = 0.9;
const ATTEMPT_VELOCITY = 0.7;
const MAX_NOTE_SEC = 0.6;
const MIN_NOTE_SEC = 0.15;
/** Notes closer than this are one chord when replaying an attempt. */
const CHORD_SPREAD_MS = 80;

export interface Attempt {
  notes: readonly NoteEvent[];
}

const TARGET_VELOCITY = 0.8;
const TARGET_NOTE_SEC = 0.8;
const TARGET_GAP_SEC = 0.6;
const RHYTHM_NOTE_SEC = 0.25;
const TONIC_GAP_SEC = 0.3;

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
    case "line": {
      // A phrase: the count-in, then each note at its place in the bar.
      const beatSec = 60 / play.tempoBpm;
      const countInEnd = countIn.reduce((end, e) => Math.max(end, e.atSec + beatSec), 0);
      return [
        ...countIn,
        ...play.midi.map((m, i) => ({
          atSec: countInEnd + (play.onsetsBeats[i] ?? 0) * beatSec,
          midi: [m],
          durationSec: Math.min(TARGET_NOTE_SEC, beatSec * 0.9),
          velocity: TARGET_VELOCITY,
          role: "target" as const,
        })),
      ];
    }
    case "chordLine": {
      // The count-in, then each chord struck together at its place in the bar.
      const beatSec = 60 / play.tempoBpm;
      const countInEnd = countIn.reduce((end, e) => Math.max(end, e.atSec + beatSec), 0);
      return [
        ...countIn,
        ...play.chords.map((c) => ({
          atSec: countInEnd + c.onsetBeats * beatSec,
          midi: c.midi,
          durationSec: Math.min(TARGET_NOTE_SEC, c.durationBeats * beatSec * 0.9),
          velocity: TARGET_VELOCITY,
          role: "target" as const,
        })),
      ];
    }
    case "performance": {
      // Both hands after the count-in, the notes of each onset struck together.
      const beatSec = 60 / play.tempoBpm;
      const countInEnd = countIn.reduce((end, e) => Math.max(end, e.atSec + beatSec), 0);
      const onsets = [...new Set(play.notes.map((n) => n.onsetBeats))].sort((a, b) => a - b);
      return [
        ...countIn,
        ...onsets.map((b) => {
          const notes = play.notes.filter((n) => n.onsetBeats === b);
          return {
            atSec: countInEnd + b * beatSec,
            midi: notes.map((n) => n.midi),
            durationSec: Math.min(
              TARGET_NOTE_SEC,
              Math.min(...notes.map((n) => n.durationBeats)) * beatSec * 0.9,
            ),
            velocity: TARGET_VELOCITY,
            role: "target" as const,
          };
        }),
      ];
    }
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
  const shifted = events.map((e) => ({ ...e, atSec: e.atSec - shift }));
  const tonic = tonicEvent(instance, shifted);
  if (!tonic) return shifted;
  const lead = tonic.durationSec + TONIC_GAP_SEC;
  return [tonic, ...shifted.map((e) => ({ ...e, atSec: e.atSec + lead }))];
}

/**
 * Items heard against a key (no cadence in the replay) start with the tonic, in the register of
 * the target, so the learner hears the target against home. Skipped when the target is the tonic.
 */
function tonicEvent(instance: ItemInstance, reference: StimulusEvent[]): StimulusEvent | undefined {
  const tonicMidi = instance.presentation.tonicMidi;
  if (instance.display || typeof tonicMidi !== "number") return undefined;
  const first = reference.find((e) => e.role === "target")?.midi[0];
  if (first === undefined || first === tonicMidi) return undefined;
  return {
    atSec: 0,
    midi: [tonicMidi],
    durationSec: TARGET_NOTE_SEC,
    velocity: TARGET_VELOCITY,
  };
}

/** Attempt notes as stimulus events starting at 0 (relative timing kept). */
export function attemptEvents(attempt: Attempt): StimulusEvent[] {
  const played = [...attempt.notes].sort((a, b) => a.onsetMs - b.onsetMs);
  const timed = played.map((n) => ({ midi: n.pitch, startMs: n.onsetMs, endMs: n.offsetMs }));
  const first = timed[0];
  if (!first) return [];
  return timed.map((n, i) => {
    const natural = n.endMs !== undefined ? (n.endMs - n.startMs) / 1000 : MAX_NOTE_SEC;
    // Tones struck together (a chord) last until the next onset that is not part of the same chord.
    const apart = timed.slice(i + 1).find((m) => m.startMs - n.startMs > CHORD_SPREAD_MS);
    const gap = apart ? (apart.startMs - n.startMs) / 1000 : MAX_NOTE_SEC;
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
