import { z } from "zod";
import type { SkillNode } from "../graph/schema.js";
import { createRng, type Rng } from "../random.js";
import type { ScoreNote, ScoreSpec, SpelledPitch, Step } from "../score/schema.js";
import { spelledToMidi } from "../score/schema.js";
import type { StimulusEvent } from "../stimulus/types.js";
import { degreeToMidi, degreeToPitchClass, tonicMidiForRange } from "../theory/degrees.js";
import { tonicChroma, type Key, type Midi, type VoiceRange } from "../theory/keys.js";
import { writtenAccidental } from "../theory/staff.js";
import { cadenceStimulus, chooseKey, keyToJson, latencyField } from "./build.js";
import { itemId } from "./ids.js";
import { PIECE_KEYBOARD_MARGIN, responseWindowMs } from "./piece-line.js";
import {
  DEFAULT_KEYBOARD_RANGE,
  type GenerateContext,
  type Generator,
  type ItemInstance,
  type ItemParams,
} from "./types.js";

/**
 * By-ear melodies (BYEAR, T7.2): a short diatonic tune is heard after the key-setting cadence with
 * no notation. The learner is cued to sing or hum it back (ungraded, R29), plays it back, and then
 * the score is revealed to check (spec 9, stages 1, 2, 4 and 7). Only the played line is graded.
 *
 * Stages the spec describes but this generator leaves out: "find the tonic" (the cadence already
 * sets home, and a played tonic adds a third response to the loop), "bass" and "harmonise" (they
 * need polyphonic input, and belong to `byear.harmonise`). `byear.melody.simple` lists only the
 * `melody` stage.
 */

/** Lengths offered, in bars of 4/4. The node's `bars` range picks the ones inside it. */
export const BYEAR_BARS = [4, 6, 8] as const;
/** Melodies per length. Slot numbers are the item identity within a length (R1). */
export const BYEAR_SLOTS_PER_LENGTH = 6;
/** Quarter notes per minute. A gentle pace: the learner audiates and plays from memory. */
export const BYEAR_TEMPO_BPM = 80;
export const BYEAR_BEATS_PER_BAR = 4;
/** A little air between notes so each one is heard as a new note. */
const NOTE_GAP = 0.92;
/** The tune spans at most an octave (7 scale steps). */
const MAX_SPAN = 7;
const STABLE_DEGREES = [1, 3, 5] as const;
/** Landing notes at the middle of the tune, a half close. */
const HALF_CLOSE_DEGREES = [2, 3, 5] as const;
const MAX_ATTEMPTS = 5000;

const NodeParams = z.object({
  bars: z.tuple([z.int().min(1), z.int().min(1)]),
  stages: z.array(z.string()).min(1),
});
const ItemParamsSchema = z.object({
  bars: z.int(),
  slot: z.int().min(1).max(BYEAR_SLOTS_PER_LENGTH),
});

/** A melody as scale degrees (1 = tonic) with each note's length in quarter-note beats. */
export interface Melody {
  degrees: number[];
  beats: number[];
}

/** Bar rhythms in beats. Half notes carry the phrase ends; eighths come in pairs. */
const MID_BARS: readonly (readonly number[])[] = [
  [2, 2],
  [1, 1, 2],
  [2, 1, 1],
  [1, 1, 1, 1],
  [1, 0.5, 0.5, 2],
  [2, 1, 0.5, 0.5],
  [1, 1, 0.5, 0.5, 1],
];
/** The bar that ends the first half of the tune: it ends on a half note. */
const HALF_CLOSE_BARS: readonly (readonly number[])[] = [
  [1, 1, 2],
  [2, 2],
  [1, 0.5, 0.5, 2],
];
const FINAL_BARS: readonly (readonly number[])[] = [[2, 2], [1, 1, 2], [4]];

function melodySeed(bars: number, slot: number): number {
  return (Math.imul(bars, 0x9e3779b1) ^ Math.imul(slot, 0x85ebca6b) ^ 0x7e11) >>> 0;
}

function rhythmFor(bars: number, rng: Rng): number[] {
  const out: number[] = [];
  const closeBar = bars / 2 - 1;
  for (let bar = 0; bar < bars; bar++) {
    const choices = bar === bars - 1 ? FINAL_BARS : bar === closeBar ? HALF_CLOSE_BARS : MID_BARS;
    out.push(...rng.pick(choices));
  }
  return out;
}

/** Index of the last note of the bar that closes the first half. */
function halfCloseIndex(beats: readonly number[], bars: number): number {
  const target = (bars / 2) * BYEAR_BEATS_PER_BAR;
  let t = 0;
  for (let i = 0; i < beats.length; i++) {
    t += beats[i] ?? 0;
    if (Math.abs(t - target) < 1e-9) return i;
  }
  throw new RangeError("rhythm has no half close");
}

function walk(count: number, rng: Rng): number[] {
  const degrees: number[] = [rng.pick(STABLE_DEGREES)];
  let low = degrees[0] ?? 1;
  let high = low;
  for (let i = 1; i < count; i++) {
    const prev = degrees[i - 1] ?? 1;
    const r = rng.next();
    const size = r < 0.68 ? 1 : r < 0.86 ? 2 : r < 0.95 ? 3 : 4;
    const upChance = Math.min(0.85, Math.max(0.15, 0.5 + (4 - prev) * 0.08));
    const next = prev + (rng.next() < upChance ? size : -size);
    low = Math.min(low, next);
    high = Math.max(high, next);
    if (high - low > MAX_SPAN) {
      // Out of range: turn the move round, which keeps the tune inside its octave.
      const turned = prev + (next > prev ? -size : size);
      degrees.push(turned);
      low = Math.min(...degrees);
      high = Math.max(...degrees);
    } else {
      degrees.push(next);
    }
  }
  return degrees;
}

/** The rules a melody must meet. Exported so tests can hold every item to them. */
export function melodyIsValid(m: Melody, bars: number): boolean {
  const d = m.degrees;
  const first = d[0];
  const last = d[d.length - 1];
  const penultimate = d[d.length - 2];
  if (first === undefined || last === undefined || penultimate === undefined) return false;
  if (!STABLE_DEGREES.some((s) => s === first)) return false;
  if (last !== 1 && last !== 8) return false;
  if (Math.abs(last - penultimate) > 2) return false;
  if (Math.max(...d) - Math.min(...d) > MAX_SPAN) return false;
  const mid = d[halfCloseIndex(m.beats, bars)];
  if (mid === undefined || !HALF_CLOSE_DEGREES.some((s) => s === mid)) return false;
  let steps = 0;
  let skipRun = 0;
  for (let i = 1; i < d.length; i++) {
    const move = Math.abs((d[i] ?? 0) - (d[i - 1] ?? 0));
    if (move === 0 || move > 4) return false;
    if (move === 1) {
      steps++;
      skipRun = 0;
    } else if (++skipRun > 2) return false;
  }
  return steps / (d.length - 1) >= 0.6;
}

/**
 * The melody of a slot, a pure function of its length and slot number: diatonic, mostly stepwise
 * with the odd skip of a third, fourth or fifth, starting on 1, 3 or 5, closing the first half on
 * 2, 3 or 5 and ending on the tonic, within an octave. Quarters and eighths, with half notes at
 * the phrase ends. Found by seeded rejection sampling, so it is the same on every device.
 */
export function melodyFor(bars: number, slot: number): Melody {
  const rng = createRng(melodySeed(bars, slot));
  const beats = rhythmFor(bars, rng);
  const n = beats.length;
  const mid = halfCloseIndex(beats, bars);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const degrees = walk(n - 1, rng);
    const prev = degrees[degrees.length - 1] ?? 1;
    degrees.push(Math.abs(prev - 8) < Math.abs(prev - 1) ? 8 : 1);
    if (!HALF_CLOSE_DEGREES.some((s) => s === degrees[mid])) continue;
    const melody = { degrees, beats };
    if (melodyIsValid(melody, bars)) return melody;
  }
  throw new RangeError(`no melody found for ${String(bars)} bars, slot ${String(slot)}`);
}

const STEP_LETTERS: readonly Step[] = ["C", "D", "E", "F", "G", "A", "B"];

function spell(key: Key, degree: number, tonicMidi: Midi): SpelledPitch {
  const name = degreeToPitchClass(key, degree);
  const step = STEP_LETTERS.find((s) => s === name.charAt(0));
  if (step === undefined) throw new RangeError(`bad pitch class ${name}`);
  const marks = name.slice(1);
  const alter = marks.split("#").length - marks.split("b").length;
  const midi = degreeToMidi(key, degree, tonicMidi);
  const octave = (midi - spelledToMidi({ step, alter, octave: 0 })) / 12;
  return { step, alter, octave };
}

const NOTE_VALUE: Record<number, 1 | 2 | 4 | 8> = { 4: 1, 2: 2, 1: 4, 0.5: 8 };

/** The melody as a one staff score in the key, a bar at a time, for the reveal. */
function melodyScore(
  melody: Melody,
  key: Key,
  tonicMidi: Midi,
  midi: readonly number[],
): ScoreSpec {
  const mean = midi.reduce((a, b) => a + b, 0) / midi.length;
  const measures: ScoreNote[][] = [];
  let bar: ScoreNote[] = [];
  let filled = 0;
  melody.degrees.forEach((degree, i) => {
    const beats = melody.beats[i] ?? 1;
    const value = NOTE_VALUE[beats];
    if (value === undefined) throw new RangeError(`unwritable length ${String(beats)}`);
    const pitch = spell(key, degree, tonicMidi);
    const accidental = writtenAccidental(pitch, key);
    bar.push({
      kind: "note",
      id: `n${String(i + 1)}`,
      pitches: [pitch],
      duration: { value, dots: 0 },
      ...(accidental === undefined ? {} : { accidental }),
    });
    filled += beats;
    if (filled >= BYEAR_BEATS_PER_BAR) {
      measures.push(bar);
      bar = [];
      filled = 0;
    }
  });
  return {
    staves: [{ clef: mean >= 57 ? "treble" : "bass", lines: 5, measures }],
    key: { tonic: key.tonic, mode: key.mode },
    meter: { beats: BYEAR_BEATS_PER_BAR, beatValue: 4 },
  };
}

export const byEarPhrase: Generator = {
  id: "byEarPhrase",
  listItems(node: SkillNode): ItemParams[] {
    const { bars } = NodeParams.parse(node.params);
    const out: ItemParams[] = [];
    for (const length of BYEAR_BARS) {
      if (length < bars[0] || length > bars[1]) continue;
      for (let slot = 1; slot <= BYEAR_SLOTS_PER_LENGTH; slot++) out.push({ bars: length, slot });
    }
    return out;
  },
  generate(node: SkillNode, params: ItemParams, ctx: GenerateContext): ItemInstance {
    const np = NodeParams.parse(node.params);
    const { bars, slot } = ItemParamsSchema.parse(params);
    if (!BYEAR_BARS.some((b) => b === bars) || bars < np.bars[0] || bars > np.bars[1]) {
      throw new RangeError(`melody length ${String(bars)} bars is not offered`);
    }
    const { rng } = ctx;
    const key = chooseKey("major", ctx.preferredKey, rng);
    const seed = rng.int(0, 0x7fffffff);
    const melody = melodyFor(bars, slot);

    // The register follows the keyboard (R29): the tune is played back, not sung.
    const range: VoiceRange = ctx.keyboardRange ?? DEFAULT_KEYBOARD_RANGE;
    const { tonicMidi } = tonicMidiForRange(key, range, {
      low: Math.min(...melody.degrees),
      high: Math.max(...melody.degrees),
    });
    const midi = melody.degrees.map((d) => degreeToMidi(key, d, tonicMidi));
    const onsetsBeats: number[] = [];
    let t = 0;
    for (const b of melody.beats) {
      onsetsBeats.push(t);
      t += b;
    }

    const tempoBpm = BYEAR_TEMPO_BPM;
    const cad = cadenceStimulus(key, { tempoBpm });
    const events: StimulusEvent[] = [
      ...cad.events,
      ...midi.map((m, i): StimulusEvent => ({
        atSec: cad.targetStartSec + (onsetsBeats[i] ?? 0) * cad.beatSec,
        midi: [m],
        durationSec: (melody.beats[i] ?? 1) * cad.beatSec * NOTE_GAP,
        velocity: 0.8,
        role: "target",
      })),
    ];
    const inputRange: VoiceRange = {
      low: Math.max(21, Math.min(...midi) - PIECE_KEYBOARD_MARGIN),
      high: Math.min(108, Math.max(...midi) + PIECE_KEYBOARD_MARGIN),
    };
    const itemParams: ItemParams = { bars, slot };
    return {
      itemId: itemId(node.id, itemParams),
      nodeId: node.id,
      generator: "byEarPhrase",
      params: itemParams,
      presentation: {
        key: keyToJson(key),
        tonic: key.tonic,
        mode: key.mode,
        tonicMidi,
        tonicChroma: tonicChroma(key),
        bars,
        slot,
        degrees: melody.degrees,
        beats: melody.beats,
        targetMidi: midi,
        onsetsBeats,
        tempoBpm,
        seed,
      },
      stimulus: { events, tempoBpm },
      reveal: melodyScore(melody, key, tonicMidi, midi),
      inputRange,
      cue: true,
      expected: {
        play: {
          kind: "line",
          midi,
          onsetsBeats,
          tempoBpm,
          beatsPerBar: BYEAR_BEATS_PER_BAR,
        },
        responseWindowMs: responseWindowMs(onsetsBeats, tempoBpm),
      },
      ...latencyField(node),
    };
  },
};
