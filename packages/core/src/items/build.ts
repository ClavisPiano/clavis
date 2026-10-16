import type { SkillNode } from "../graph/schema.js";
import type { JsonObject } from "../json.js";
import type { Rng } from "../random.js";
import type { StimulusEvent } from "../stimulus/types.js";
import { cadence } from "../theory/cadence.js";
import { degreeToMidi, midiToDegree, type DegreeOptions } from "../theory/degrees.js";
import { ALL_KEYS, tonicChroma, type Key, type Midi, type VoiceRange } from "../theory/keys.js";
import type { DegreeLabels } from "./expected.js";

export const DEFAULT_TEMPO_BPM = 90;
export const CADENCE_VELOCITY = 0.7;
/** Silence between the last cadence chord and the target, in beats. */
export const CADENCE_GAP_BEATS = 0.6;

export interface CadenceStimulusOptions {
  tempoBpm?: number;
  velocity?: number;
  gapBeats?: number;
}

export interface CadenceStimulus {
  /** Cadence events, one chord per beat, role "cadence". */
  events: StimulusEvent[];
  /** Seconds from stimulus start at which the target should begin (after the gap). */
  targetStartSec: number;
  beatSec: number;
  tempoBpm: number;
}

/**
 * The context-setting cadence (spec 2): every ear item that is heard against a key starts
 * with `theory.cadence(key)`, one chord per beat (bass plus upper voices), then a short gap.
 */
export function cadenceStimulus(key: Key, opts: CadenceStimulusOptions = {}): CadenceStimulus {
  const tempoBpm = opts.tempoBpm ?? DEFAULT_TEMPO_BPM;
  const velocity = opts.velocity ?? CADENCE_VELOCITY;
  const beatSec = 60 / tempoBpm;
  const { chords } = cadence(key);
  const events = chords.map((c, i): StimulusEvent => ({
    atSec: i * beatSec,
    midi: [c.bass, ...c.upper],
    durationSec: beatSec,
    velocity,
    role: "cadence",
  }));
  const gap = opts.gapBeats ?? CADENCE_GAP_BEATS;
  return { events, targetStartSec: (chords.length + gap) * beatSec, beatSec, tempoBpm };
}

/**
 * Degree label of each pitch class (index 0 = C) in the key, e.g. "1", "b3", "#4".
 * Labels are scale-relative (octave removed).
 */
export function degreeLabels(key: Key, opts?: DegreeOptions): DegreeLabels {
  const tonicMidi = 60 + tonicChroma(key);
  return Array.from({ length: 12 }, (_, pc) => {
    const { degree, alteration } = midiToDegree(key, 60 + pc, tonicMidi, opts);
    const d = ((((degree - 1) % 7) + 7) % 7) + 1;
    return `${alteration < 0 ? "b" : alteration > 0 ? "#" : ""}${String(d)}`;
  });
}

/**
 * Tonic for an item in `mode`: the key of the day when its mode matches (spec 6.3),
 * otherwise a random key of that mode.
 */
export function chooseKey(mode: Key["mode"], preferred: Key | undefined, rng: Rng): Key {
  if (preferred?.mode === mode) return { ...preferred };
  return rng.pick(ALL_KEYS.filter((k) => k.mode === mode));
}

export function keyToJson(key: Key): JsonObject {
  return { tonic: key.tonic, mode: key.mode };
}

/** Optional latency target carried from the node. */
export function latencyField(node: SkillNode): { targetLatencyMs?: number } {
  return node.targetLatencyMs === undefined ? {} : { targetLatencyMs: node.targetLatencyMs };
}

/**
 * The middle voice of the cadence's last chord: where the ear is when the target note comes.
 */
export function cadenceCentreMidi(key: Key): Midi {
  const last = cadence(key).chords.at(-1);
  const upper = [...(last?.upper ?? [])].sort((a, b) => a - b);
  return upper[Math.floor(upper.length / 2)] ?? 64;
}

/** The tonic in the octave of the cadence's last chord (the one nearest its middle voice). */
export function tonicNearCadence(key: Key): Midi {
  const centre = cadenceCentreMidi(key);
  const c = tonicChroma(key);
  return c + 12 * Math.round((centre - c) / 12);
}

/**
 * Put target notes in the register of the cadence, so a target is heard against the chord it
 * follows and not an octave away from it. The tonic is the one nearest the cadence's last chord.
 * A single degree is placed within a tritone of the chord's middle voice (a 7 sits just under
 * the tonic); `keepShape` keeps a group of degrees together above that tonic instead (melodic
 * cells). Undefined when the notes do not fit `range`, so the caller can place them another way.
 */
export function registerNearCadence(
  key: Key,
  degrees: readonly number[],
  range: VoiceRange,
  opts?: DegreeOptions,
  keepShape = false,
): { tonicMidi: Midi; midi: Midi[] } | undefined {
  const tonicMidi = tonicNearCadence(key);
  const centre = cadenceCentreMidi(key);
  const midi = degrees.map((degree) => {
    const note = degreeToMidi(key, degree, tonicMidi, opts);
    return keepShape ? note : note + 12 * Math.round((centre - note) / 12);
  });
  return midi.every((m) => m >= range.low && m <= range.high) ? { tonicMidi, midi } : undefined;
}
