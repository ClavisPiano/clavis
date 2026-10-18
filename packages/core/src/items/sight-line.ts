import { z } from "zod";
import type { SkillNode } from "../graph/schema.js";
import { createRng, type Rng } from "../random.js";
import type { ScoreNote, ScoreSpec, SpelledPitch, Step } from "../score/schema.js";
import type { StimulusEvent } from "../stimulus/types.js";
import type { Key, KeyFamily, Midi, VoiceRange } from "../theory/keys.js";
import {
  positionInKey,
  stepOffset,
  writtenAccidental,
  type StaffPosition,
} from "../theory/staff.js";
import { keyToJson, latencyField } from "./build.js";
import type { PerformanceTarget } from "./expected.js";
import { keyForFamily } from "./family.js";
import { itemId } from "./ids.js";
import { COUNT_IN_PITCH, COUNT_IN_VELOCITY } from "./rhythm.js";
import type { GenerateContext, Generator, ItemInstance, ItemParams } from "./types.js";

/*
 * Grand-staff reading lines (T5.11, spec 7 `sightLine`, nodes read.grand.2line and
 * read.grand.sight). One item is a short line on a grand staff in a major key: the right hand plays
 * single notes on the treble staff, the left hand single notes or bare fifths on the bass staff,
 * one chord (I, IV, V, and vi for sight-reading) per bar. It is read and played after a one-bar
 * count-in and graded as a `performance` (R27), so it needs polyphonic input (MIDI only).
 *
 * Identity (R1, R15): `nodeId|bars=4|fam=A|slot=2`. The line (chords, rhythm, scale steps) is a pure
 * function of the node's style, the length and the slot, the same in every key family; the key is
 * presentation (the key of the day when it is in the family) and only moves the line to that key.
 */

/** Lengths offered, in bars of 4/4. A node's `bars` range picks the ones inside it. */
export const SIGHT_LINE_BARS = [2, 4, 6, 8] as const;
/** Lines per length and key family. Slot numbers are the item identity within a length. */
export const SIGHT_LINE_SLOTS = 6;
/** Slow and steady: the learner reads two staves at once. */
export const SIGHT_LINE_TEMPO_BPM = 60;
export const SIGHT_LINE_BEATS_PER_BAR = 4;

/** Right hand: C4 to A5, the treble staff with a ledger line either side. */
export const SIGHT_RH_RANGE: VoiceRange = { low: 60, high: 81 };
/** Left hand: roots F2 to E3 with a fifth above at most B3, around the bass staff. */
export const SIGHT_LH_RANGE: VoiceRange = { low: 41, high: 59 };
const LH_ROOT_LOW = 41;
const LH_ROOT_HIGH = 52;
/** The right hand sits as near the middle line of the treble staff (B4) as the key allows. */
const RH_CENTRE = 71;
/** Room either side of the line on the on-screen keyboard, in semitones. */
const KEYBOARD_MARGIN = 4;

const FAMILIES: readonly KeyFamily[] = ["A", "B", "C"];
const STEPS: readonly Step[] = ["C", "D", "E", "F", "G", "A", "B"];
const MAX_ATTEMPTS = 2000;

/**
 * `lines` (read.grand.2line): quarters and longer, the left hand holding one note or one fifth a
 * bar, the right hand in a five-finger span. `sight` (read.grand.sight): eighth notes, the vi chord
 * and a left hand that may move within the bar, the right hand within a sixth.
 */
export type SightLineStyle = "lines" | "sight";

const NodeParams = z.object({
  staves: z.literal("grand"),
  bars: z.tuple([z.int().min(1), z.int().min(1)]),
  style: z.enum(["lines", "sight"]),
});
const ItemParamsSchema = z.object({
  fam: z.enum(["A", "B", "C"]),
  bars: z.int(),
  slot: z.int().min(1).max(SIGHT_LINE_SLOTS),
});

/** One note of a hand: diatonic steps and its length in beats. */
export interface SightNote {
  /**
   * Right hand: one step above the tonic (0 the tonic, 7 the octave above, -1 the leading note
   * below). Left hand: steps above the bar's chord root, `[0]` the root, `[0, 4]` root and fifth.
   */
  steps: number[];
  beats: number;
}

/** A line as written, before it is put in a key. */
export interface SightLine {
  /** One chord per bar, as a major-key Roman numeral. */
  chords: string[];
  rh: SightNote[][];
  lh: SightNote[][];
}

/** Root of each numeral in scale steps above the tonic. */
const ROOT_STEP: Record<string, number> = { I: 0, IV: 3, V: 4, vi: 5 };

interface StyleRules {
  chords: readonly string[];
  /** Right-hand bar rhythms in beats; the last bar uses `rhFinal`. */
  rhBars: readonly (readonly number[])[];
  rhFinal: readonly (readonly number[])[];
  /** Widest right-hand span, in scale steps. */
  maxSpan: number;
  /** Moves between beats 1 and 3, in scale steps (repeats make one likelier). */
  weakMoves: readonly number[];
}

const STYLE: Record<SightLineStyle, StyleRules> = {
  lines: {
    chords: ["I", "IV", "V"],
    rhBars: [[4], [2, 2], [1, 1, 2], [2, 1, 1], [1, 1, 1, 1]],
    rhFinal: [[4], [2, 2]],
    maxSpan: 4,
    weakMoves: [1],
  },
  sight: {
    chords: ["I", "IV", "V", "vi"],
    rhBars: [
      [2, 2],
      [1, 1, 2],
      [2, 1, 1],
      [1, 1, 1, 1],
      [1, 0.5, 0.5, 2],
      [2, 1, 0.5, 0.5],
      [1, 1, 0.5, 0.5, 1],
      [0.5, 0.5, 1, 2],
    ],
    rhFinal: [[4], [2, 2], [1, 1, 2]],
    maxSpan: 5,
    weakMoves: [1, 1, 1, 2],
  },
};

/** Left-hand bars for sight-reading: a held root or fifth, root then fifth, or a repeated fifth. */
const SIGHT_LH_BARS: readonly (readonly SightNote[])[] = [
  [{ steps: [0], beats: 4 }],
  [{ steps: [0, 4], beats: 4 }],
  [
    { steps: [0], beats: 2 },
    { steps: [4], beats: 2 },
  ],
  [
    { steps: [0, 4], beats: 2 },
    { steps: [0, 4], beats: 2 },
  ],
];

function lineSeed(style: SightLineStyle, bars: number, slot: number): number {
  const s = style === "lines" ? 0x51c4 : 0x9a77;
  return (Math.imul(bars, 0x9e3779b1) ^ Math.imul(slot, 0x85ebca6b) ^ s) >>> 0;
}

const mod7 = (n: number): number => ((n % 7) + 7) % 7;

function chordTones(roman: string): number[] {
  const r = ROOT_STEP[roman];
  if (r === undefined) throw new RangeError(`unknown numeral ${roman}`);
  return [r, r + 2, r + 4].map(mod7);
}

function progression(style: SightLineStyle, bars: number, rng: Rng): string[] {
  if (bars === 2) return [rng.pick(["I", "IV", "V"]), "I"];
  const pool = STYLE[style].chords;
  const out = ["I"];
  for (let bar = 1; bar < bars - 2; bar++) {
    const prev = out[bar - 1];
    // The bar before the closing V is not V itself, so the V arrives as a change.
    const next = bar === bars - 3 ? pool.filter((c) => c !== "V") : pool;
    out.push(rng.pick(next.filter((c) => c !== prev)));
  }
  out.push("V", "I");
  return out;
}

/** Pick with weights (higher is likelier). */
function weighted<T>(items: readonly T[], weight: (t: T) => number, rng: Rng): T | undefined {
  const total = items.reduce((s, t) => s + weight(t), 0);
  if (items.length === 0 || total <= 0) return undefined;
  let r = rng.next() * total;
  for (const t of items) {
    r -= weight(t);
    if (r < 0) return t;
  }
  return items[items.length - 1];
}

/** The right-hand steps, or undefined when this attempt ran into a dead end. */
function melody(
  style: SightLineStyle,
  chords: readonly string[],
  rhythm: readonly (readonly number[])[],
  rng: Rng,
): number[] | undefined {
  const { weakMoves } = STYLE[style];
  const total = rhythm.reduce((n, bar) => n + bar.length, 0);
  const out: number[] = [];
  for (const [b, bar] of rhythm.entries()) {
    const tones = chordTones(chords[b] ?? "I");
    let t = 0;
    for (const beats of bar) {
      const prev = out[out.length - 1];
      const isLast = out.length === total - 1;
      // Beats 1 and 3 carry a chord tone; the notes between them move by step.
      const strong = t === 0 || t === 2;
      let candidates: number[];
      if (prev === undefined) candidates = [0, 2, 4].filter((s) => tones.includes(mod7(s)));
      else if (isLast) candidates = [0, 7].filter((s) => Math.abs(s - prev) <= 2);
      else if (strong) {
        candidates = [];
        for (let s = prev - 4; s <= prev + 4; s++) {
          if (s >= -3 && s <= 9 && tones.includes(mod7(s))) candidates.push(s);
        }
      } else {
        candidates = weakMoves.flatMap((m) => [prev + m, prev - m]);
      }
      const next = weighted(
        candidates,
        (s) => (prev === undefined ? 1 : s === prev ? 0.4 : 1 / Math.abs(s - prev)),
        rng,
      );
      if (next === undefined) return undefined;
      out.push(next);
      t += beats;
    }
  }
  return out;
}

/** The rules a right-hand line meets. Exported so tests can hold every item to them. */
export function sightMelodyIsValid(style: SightLineStyle, steps: readonly number[]): boolean {
  const last = steps[steps.length - 1];
  if (last === undefined || (last !== 0 && last !== 7)) return false;
  if (Math.max(...steps) - Math.min(...steps) > STYLE[style].maxSpan) return false;
  let stepwise = 0;
  for (let i = 1; i < steps.length; i++) {
    const move = Math.abs((steps[i] ?? 0) - (steps[i - 1] ?? 0));
    if (move > 4) return false;
    // A note may repeat once, never three times running.
    if (move === 0 && i >= 2 && steps[i - 2] === steps[i]) return false;
    if (move === 1) stepwise++;
  }
  return steps.length < 3 || stepwise / (steps.length - 1) >= 0.5;
}

/**
 * The line of a slot, a pure function of the style, length and slot: one chord a bar starting on
 * I and closing V-I (or two bars ending on I), the right hand on a chord tone on beats 1 and 3 and
 * moving by step between them, ending on the tonic. Found by seeded rejection sampling, so it is
 * the same on every device.
 */
export function sightLineFor(style: SightLineStyle, bars: number, slot: number): SightLine {
  const rng = createRng(lineSeed(style, bars, slot));
  const s = STYLE[style];
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const chords = progression(style, bars, rng);
    const rhythm = chords.map((_, b) => rng.pick(b === bars - 1 ? s.rhFinal : s.rhBars));
    const steps = melody(style, chords, rhythm, rng);
    if (steps === undefined || !sightMelodyIsValid(style, steps)) continue;
    const fifths = rng.next() < 0.5;
    const lh = chords.map((_, b): SightNote[] => {
      if (style === "lines" || b === bars - 1) return [{ steps: fifths ? [0, 4] : [0], beats: 4 }];
      return rng.pick(SIGHT_LH_BARS).map((n) => ({ steps: [...n.steps], beats: n.beats }));
    });
    let i = 0;
    const rh = rhythm.map((bar) => bar.map((beats) => ({ steps: [steps[i++] ?? 0], beats })));
    return { chords, rh, lh };
  }
  throw new RangeError(`no line found for ${style}, ${String(bars)} bars, slot ${String(slot)}`);
}

/** Lengths a node offers: the standard lengths inside its `bars` range. */
function lengthsFor(range: readonly [number, number]): number[] {
  return SIGHT_LINE_BARS.filter((b) => b >= range[0] && b <= range[1]);
}

function tonicLetter(key: Key): Step {
  const letter = STEPS.find((s) => s === key.tonic.charAt(0));
  if (letter === undefined) throw new RangeError(`bad tonic ${key.tonic}`);
  return letter;
}

/** A written note placed in the key: staff position, spelled pitch and sounding MIDI. */
interface Placed {
  pitch: SpelledPitch;
  midi: Midi;
}

/** Right-hand positions: the tonic octave that keeps the line in range, nearest the staff middle. */
function placeRh(line: SightLine, key: Key): Placed[][] {
  const letter = tonicLetter(key);
  let best: { notes: Placed[][]; dist: number } | undefined;
  for (let octave = 2; octave <= 6; octave++) {
    const tonic: StaffPosition = { step: letter, octave };
    const notes = line.rh.map((bar) =>
      bar.map((n) => positionInKey(stepOffset(tonic, n.steps[0] ?? 0), key)),
    );
    const midi = notes.flat().map((p) => p.midi);
    if (Math.min(...midi) < SIGHT_RH_RANGE.low || Math.max(...midi) > SIGHT_RH_RANGE.high) continue;
    const mean = midi.reduce((a, b) => a + b, 0) / midi.length;
    const dist = Math.abs(mean - RH_CENTRE);
    if (best === undefined || dist < best.dist) best = { notes, dist };
  }
  if (best === undefined) throw new RangeError(`line does not fit the right hand in ${key.tonic}`);
  return best.notes;
}

/** Left-hand positions: each bar's root in F2 to E3 (one place per pitch), the fifth above it. */
function placeLh(line: SightLine, key: Key): Placed[][][] {
  const letter = tonicLetter(key);
  return line.lh.map((bar, b) => {
    const rootStep = ROOT_STEP[line.chords[b] ?? "I"] ?? 0;
    let root: StaffPosition | undefined;
    for (let octave = 1; octave <= 4; octave++) {
      const pos = stepOffset({ step: letter, octave }, rootStep);
      const { midi } = positionInKey(pos, key);
      if (midi >= LH_ROOT_LOW && midi <= LH_ROOT_HIGH) root = pos;
    }
    if (root === undefined) throw new RangeError(`no left-hand root in ${key.tonic}`);
    const r = root;
    return bar.map((n) => n.steps.map((s) => positionInKey(stepOffset(r, s), key)));
  });
}

const NOTE_VALUE: Record<number, 1 | 2 | 4 | 8> = { 4: 1, 2: 2, 1: 4, 0.5: 8 };

function scoreNote(id: string, pitches: SpelledPitch[], beats: number, key: Key): ScoreNote {
  const value = NOTE_VALUE[beats];
  if (value === undefined) throw new RangeError(`unwritable length ${String(beats)}`);
  const accidental = pitches.map((p) => writtenAccidental(p, key)).find((a) => a !== undefined);
  return {
    kind: "note",
    id,
    pitches,
    duration: { value, dots: 0 },
    ...(accidental === undefined ? {} : { accidental }),
  };
}

/**
 * A line in a key: the grand staff, and the performance target with the same note ids (a fifth's
 * tones `n9.0` and `n9.1`, lowest first, as `expectedFromScore` names them).
 */
export function sightLineScore(
  line: SightLine,
  key: Key,
): { score: ScoreSpec; notes: PerformanceTarget["notes"] } {
  if (key.mode !== "major") throw new RangeError("sightLine supports major keys only");
  const rh = placeRh(line, key);
  const lh = placeLh(line, key);
  let next = 1;
  const notes: PerformanceTarget["notes"] = [];
  const treble = line.rh.map((bar, b) => {
    let t = b * SIGHT_LINE_BEATS_PER_BAR;
    return bar.map((n, i) => {
      const id = `n${String(next++)}`;
      const p = rh[b]?.[i];
      if (p === undefined) throw new RangeError("right hand note not placed");
      notes.push({ id, midi: p.midi, onsetBeats: t, durationBeats: n.beats, hand: "rh" });
      t += n.beats;
      return scoreNote(id, [p.pitch], n.beats, key);
    });
  });
  const bass = line.lh.map((bar, b) => {
    let t = b * SIGHT_LINE_BEATS_PER_BAR;
    return bar.map((n, i) => {
      const id = `n${String(next++)}`;
      const ps = [...(lh[b]?.[i] ?? [])].sort((x, y) => x.midi - y.midi);
      ps.forEach((p, k) => {
        notes.push({
          id: ps.length === 1 ? id : `${id}.${String(k)}`,
          midi: p.midi,
          onsetBeats: t,
          durationBeats: n.beats,
          hand: "lh",
        });
      });
      t += n.beats;
      return scoreNote(
        id,
        ps.map((p) => p.pitch),
        n.beats,
        key,
      );
    });
  });
  // Onset order; notes that start together keep the right hand first (stable sort).
  notes.sort((a, b) => a.onsetBeats - b.onsetBeats);
  return {
    score: {
      staves: [
        { clef: "treble", lines: 5, measures: treble },
        { clef: "bass", lines: 5, measures: bass },
      ],
      key: { tonic: key.tonic, mode: key.mode },
      meter: { beats: SIGHT_LINE_BEATS_PER_BAR, beatValue: 4 },
    },
    notes,
  };
}

/** Time to play the line after the count-in: the line twice over and time to find the first note. */
export function sightLineWindowMs(totalBeats: number, tempoBpm: number): number {
  return Math.round(Math.max(15000, totalBeats * (60000 / tempoBpm) * 2 + 8000));
}

export const sightLine: Generator = {
  id: "sightLine",
  listItems(node: SkillNode): ItemParams[] {
    const { bars } = NodeParams.parse(node.params);
    const lengths = lengthsFor(bars);
    return FAMILIES.flatMap((fam) =>
      lengths.flatMap((length) =>
        Array.from({ length: SIGHT_LINE_SLOTS }, (_, i) => ({ fam, bars: length, slot: i + 1 })),
      ),
    );
  },
  generate(node: SkillNode, params: ItemParams, ctx: GenerateContext): ItemInstance {
    const np = NodeParams.parse(node.params);
    const ip = ItemParamsSchema.parse(params);
    if (!lengthsFor(np.bars).includes(ip.bars)) {
      throw new RangeError(`a ${String(ip.bars)} bar line is not offered by ${node.id}`);
    }
    const { rng } = ctx;
    const key = keyForFamily(ip.fam, "major", ctx.preferredKey, rng);
    const seed = rng.int(0, 0x7fffffff);
    const line = sightLineFor(np.style, ip.bars, ip.slot);
    const { score, notes } = sightLineScore(line, key);
    const tempoBpm = SIGHT_LINE_TEMPO_BPM;
    const beatSec = 60 / tempoBpm;
    const countIn: StimulusEvent[] = Array.from({ length: SIGHT_LINE_BEATS_PER_BAR }, (_, i) => ({
      atSec: i * beatSec,
      midi: [COUNT_IN_PITCH],
      durationSec: 0.1,
      velocity: COUNT_IN_VELOCITY,
      role: "count-in" as const,
    }));
    const target: PerformanceTarget = {
      kind: "performance",
      notes,
      tempoBpm,
      beatsPerBar: SIGHT_LINE_BEATS_PER_BAR,
    };
    const all = notes.map((n) => n.midi);
    const idParams: ItemParams = { fam: ip.fam, bars: ip.bars, slot: ip.slot };
    return {
      itemId: itemId(node.id, idParams),
      nodeId: node.id,
      generator: "sightLine",
      params: idParams,
      presentation: {
        key: keyToJson(key),
        tonic: key.tonic,
        mode: key.mode,
        fam: ip.fam,
        bars: ip.bars,
        slot: ip.slot,
        chords: line.chords,
        rhMidi: notes.filter((n) => n.hand === "rh").map((n) => n.midi),
        lhMidi: notes.filter((n) => n.hand === "lh").map((n) => n.midi),
        tempoBpm,
        seed,
      },
      stimulus: { events: countIn, tempoBpm },
      display: score,
      expected: {
        play: target,
        responseWindowMs: sightLineWindowMs(ip.bars * SIGHT_LINE_BEATS_PER_BAR, tempoBpm),
      },
      inputRange: {
        low: Math.min(...all) - KEYBOARD_MARGIN,
        high: Math.max(...all) + KEYBOARD_MARGIN,
      },
      ...latencyField(node),
    };
  },
};
