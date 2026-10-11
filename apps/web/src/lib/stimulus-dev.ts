import {
  ALL_KEYS,
  cadence,
  scaleMidi,
  tonicMidiAt,
  type Key,
  type StimulusEvent,
  type StimulusSpec,
} from "@clavis/core";

export const DEV_TEMPO_BPM = 90;
const BEAT_SEC = 60 / DEV_TEMPO_BPM;

export function keyLabel(key: Key): string {
  return `${key.tonic} ${key.mode}`;
}

export const DEV_KEYS: readonly { readonly value: string; readonly key: Key }[] = ALL_KEYS.map(
  (key) => ({ value: keyLabel(key), key }),
);

/** I-IV-V-I (or minor) as one chord per beat; the final chord rings for two beats. */
export function cadenceSpec(key: Key): StimulusSpec {
  const chords = cadence(key).chords;
  const events: StimulusEvent[] = chords.map((chord, i) => {
    const last = i === chords.length - 1;
    return {
      atSec: i * BEAT_SEC,
      midi: [chord.bass, ...chord.upper],
      durationSec: (last ? 2 : 1) * BEAT_SEC * 0.95,
      velocity: 0.7,
      role: "cadence",
    };
  });
  return { events, tempoBpm: DEV_TEMPO_BPM };
}

/** One ascending octave from the tonic in octave 4, a note per beat. */
export function scaleSpec(key: Key): StimulusSpec {
  const notes = scaleMidi(key, tonicMidiAt(key, 4));
  const events: StimulusEvent[] = notes.map((midi, i) => ({
    atSec: i * BEAT_SEC,
    midi: [midi],
    durationSec: BEAT_SEC * 0.9,
    velocity: 0.7,
    role: "reference",
  }));
  return { events, tempoBpm: DEV_TEMPO_BPM };
}
