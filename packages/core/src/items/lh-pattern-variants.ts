import { z } from "zod";
import type { SkillNode } from "../graph/schema.js";
import type { Duration, ScoreNote, ScoreSpec, SpelledPitch } from "../score/schema.js";
import { spelledToMidi } from "../score/schema.js";
import type { Key, VoiceRange } from "../theory/keys.js";
import { stepOffset, writtenAccidental, type StaffPosition } from "../theory/staff.js";
import { at } from "../theory/util.js";
import { enumerateBassMotions } from "./bass-motion.js";
import { latencyField } from "./build.js";
import type { LineTarget } from "./expected.js";
import { keyForFamily } from "./family.js";
import { itemId } from "./ids.js";
import {
  LH_BEATS_PER_BAR,
  LH_CHORD_BEATS,
  LH_FAMILIES,
  LH_RANGE,
  LH_ROOT_CENTRE,
  LH_ROOT_RANGE,
  LH_TEMPO_BPM,
  LhChordsParam,
  LhItemParams,
  checkProgression,
  chordLineItem,
  lhItemOf,
  chordSymbol,
  lhChords,
  lhCountIn,
  lhInputRange,
  lhPresentation,
  lhResponseWindowMs,
  pitchName,
  speller,
  type LhChord,
} from "./lh-pattern.js";
import type { GenerateContext, Generator, ItemInstance, ItemParams } from "./types.js";

/*
 * Left-hand patterns beyond root-position block chords (T5.7, spec 7 `lhPatternVariants`, R27).
 * The same progressions and key families as `lhPattern` (four chords from the node's numerals,
 * starting on I, never the same chord twice running), the same tempo, count-in and register
 * (C2 to C4), MIDI only:
 *
 * - `hands.lh.inversions`: block chords with close voice leading. The first chord is in root
 *   position; each next chord takes the root position, first or second inversion that moves the
 *   hand least, so common tones stay put. Graded as a `chordLine`.
 * - `hands.lh.broken`: each root-position triad broken in eighths, 1-3-5-3 or Alberti 1-5-3-5.
 * - `hands.lh.pop`: root-5-8 (a quarter and two eighths) or a syncopated root-5-8 (eighth,
 *   quarter, eighth), so the fifth lands off the beat.
 *
 * The broken and pop patterns are single lines, graded as a `line` (pitch, then rhythm).
 *
 * Identity (R1, R15): `nodeId|fam=A|prog=I-IV-V-I` for inversions, and
 * `nodeId|fam=A|pattern=alberti|prog=I-IV-V-I` for the nodes with several patterns. The voicing
 * and the notes follow from the id and the key, and the key is presentation.
 */

/** The inversions a voiced triad can take. */
export const INVERSIONS = ["root", "first", "second"] as const;
export type Inversion = (typeof INVERSIONS)[number];

/** The single-line patterns, one per entry of a node's `patterns`. */
export const LINE_PATTERNS = ["broken", "alberti", "root-5-8", "syncopated"] as const;
export type LinePattern = (typeof LINE_PATTERNS)[number];

interface PatternShape {
  /** Diatonic steps above the root for each note: 0 root, 2 third, 4 fifth, 7 octave. */
  steps: readonly number[];
  /** Each note's written length; together they fill the chord's two beats. */
  durations: readonly Duration[];
}

const EIGHTH: Duration = { value: 8, dots: 0 };
const QUARTER: Duration = { value: 4, dots: 0 };

const SHAPES: Record<LinePattern, PatternShape> = {
  broken: { steps: [0, 2, 4, 2], durations: [EIGHTH, EIGHTH, EIGHTH, EIGHTH] },
  alberti: { steps: [0, 4, 2, 4], durations: [EIGHTH, EIGHTH, EIGHTH, EIGHTH] },
  "root-5-8": { steps: [0, 4, 7], durations: [QUARTER, EIGHTH, EIGHTH] },
  syncopated: { steps: [0, 4, 7], durations: [EIGHTH, QUARTER, EIGHTH] },
};

/** Beats a written duration lasts (a quarter is one beat). */
function beatsOf(d: Duration): number {
  return (4 / d.value) * (d.dots === 1 ? 1.5 : 1);
}

/**
 * Roots for a pattern: an octave above the root must still be in `LH_RANGE`, so patterns that
 * reach the octave keep their roots at C3 or below.
 */
function rootRangeFor(pattern: LinePattern): VoiceRange {
  const reach = Math.max(...SHAPES[pattern].steps) >= 7 ? 12 : 7;
  return { low: LH_ROOT_RANGE.low, high: Math.min(LH_ROOT_RANGE.high, LH_RANGE.high - reach) };
}

const InversionsNodeParams = z.object({
  pattern: z.literal("block"),
  voiceLeading: z.literal("close"),
  inversions: z.array(z.enum(INVERSIONS)).min(1),
  chords: LhChordsParam,
});
const PatternsNodeParams = z.object({
  patterns: z.array(z.enum(LINE_PATTERNS)).min(1),
  chords: LhChordsParam,
});
const NodeParams = z.union([InversionsNodeParams, PatternsNodeParams]);
const PatternItemParams = LhItemParams.extend({ pattern: z.enum(LINE_PATTERNS) });

/** A voiced triad, lowest note first, and which inversion it is. */
export interface VoicedChord extends LhChord {
  inversion: Inversion;
}

/** The three staff positions of a triad on `root` in `inversion`, lowest first. */
function voicing(root: StaffPosition, inversion: Inversion): StaffPosition[] {
  const steps = inversion === "root" ? [0, 2, 4] : inversion === "first" ? [2, 4, 7] : [4, 7, 9];
  return steps.map((n) => stepOffset(root, n));
}

/** Total movement of the voices: lowest to lowest, middle to middle, top to top, in semitones. */
function movement(from: readonly number[], to: readonly number[]): number {
  return to.reduce((sum, m, i) => sum + Math.abs(m - at(from, i)), 0);
}

/**
 * Close voice leading over `prog` in a major `key`. The first chord is in root position (when
 * allowed) with its bass nearest `LH_ROOT_CENTRE`, the chord `lhChords` starts with. Each next
 * chord is the allowed voicing, in `LH_RANGE`, that moves the three voices least in total; ties go
 * to the voicing whose bass is nearest the centre, so the hand does not drift, then to the order
 * of `INVERSIONS`. Diatonic triads share a tone or sit a step apart, so voices move by a step or
 * two, never more than a fourth.
 */
export function closeVoicings(
  key: Key,
  prog: readonly string[],
  allowed: readonly Inversion[] = INVERSIONS,
): VoicedChord[] {
  // Root-position chords give each numeral's root letter, numeral and quality.
  const roots = lhChords(key, prog);
  const spell = speller(key);
  let prev: number[] | undefined;
  return roots.map((rootChord): VoicedChord => {
    const root = at(rootChord.pitches, 0);
    const minor = rootChord.roman === rootChord.roman.toLowerCase();
    let best: { chord: VoicedChord; rank: number[] } | undefined;
    for (let octave = 0; octave <= 8; octave++) {
      for (const inversion of INVERSIONS) {
        if (!allowed.includes(inversion)) continue;
        const positions = voicing({ step: root.step, octave }, inversion);
        const pitches = positions.map(spell);
        const midi = pitches.map(spelledToMidi);
        if (Math.min(...midi) < LH_RANGE.low || Math.max(...midi) > LH_RANGE.high) continue;
        const bass = at(pitches, 0);
        const centre = Math.abs(at(midi, 0) - LH_ROOT_CENTRE);
        const rank =
          prev === undefined
            ? [inversion === "root" ? 0 : 1, centre, INVERSIONS.indexOf(inversion)]
            : [movement(prev, midi), centre, INVERSIONS.indexOf(inversion)];
        if (best === undefined || lexLess(rank, best.rank)) {
          const symbol = chordSymbol(root, minor);
          best = {
            rank,
            chord: {
              roman: rootChord.roman,
              symbol: inversion === "root" ? symbol : `${symbol}/${pitchName(bass)}`,
              pitches,
              midi,
              inversion,
            },
          };
        }
      }
    }
    if (best === undefined) throw new RangeError(`no voicing for ${rootChord.roman}`);
    prev = best.chord.midi;
    return best.chord;
  });
}

function lexLess(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const x = at(a, i);
    const y = at(b, i);
    if (x !== y) return x < y;
  }
  return false;
}

/** One note of a single-line pattern. */
export interface PatternNote {
  pitch: SpelledPitch;
  midi: number;
  /** Onset in beats from the first note. */
  onsetBeats: number;
  duration: Duration;
  /** Index of the chord the note belongs to. */
  chord: number;
}

/**
 * The notes of `pattern` over `prog` in a major `key`: each root-position triad (roots nearest the
 * previous, as `lhChords`) played as the pattern, two beats per chord.
 */
export function patternLine(
  key: Key,
  prog: readonly string[],
  pattern: LinePattern,
): { chords: LhChord[]; notes: PatternNote[] } {
  const chords = lhChords(key, prog, rootRangeFor(pattern));
  const shape = SHAPES[pattern];
  const spell = speller(key);
  const notes = chords.flatMap((c, ci) => {
    const root = at(c.pitches, 0);
    let onset = ci * LH_CHORD_BEATS;
    return shape.steps.map((n, i): PatternNote => {
      const pitch = spell(stepOffset({ step: root.step, octave: root.octave }, n));
      const midi = spelledToMidi(pitch);
      const duration = at(shape.durations, i);
      const note = { pitch, midi, onsetBeats: onset, duration, chord: ci };
      onset += beatsOf(duration);
      return note;
    });
  });
  return { chords, notes };
}

/** The line on the bass staff, `LH_BEATS_PER_BAR` beats to a bar. */
function lineScore(key: Key, notes: readonly PatternNote[]): ScoreSpec {
  const measures: ScoreNote[][] = [];
  notes.forEach((n, i) => {
    const bar = Math.floor(n.onsetBeats / LH_BEATS_PER_BAR);
    const accidental = writtenAccidental(n.pitch, key);
    (measures[bar] ??= []).push({
      kind: "note",
      id: `n${String(i + 1)}`,
      pitches: [n.pitch],
      duration: n.duration,
      ...(accidental === undefined ? {} : { accidental }),
    });
  });
  return {
    staves: [{ clef: "bass", lines: 5, measures }],
    key: { tonic: key.tonic, mode: key.mode },
    meter: { beats: LH_BEATS_PER_BAR, beatValue: 4 },
  };
}

function lineItem(
  node: SkillNode,
  idParams: ItemParams,
  key: Key,
  pattern: LinePattern,
  prog: readonly string[],
  seed: number,
): ItemInstance {
  const { chords, notes } = patternLine(key, prog, pattern);
  const tempoBpm = LH_TEMPO_BPM;
  const target: LineTarget = {
    kind: "line",
    midi: notes.map((n) => n.midi),
    onsetsBeats: notes.map((n) => n.onsetBeats),
    tempoBpm,
    beatsPerBar: LH_BEATS_PER_BAR,
  };
  return {
    itemId: itemId(node.id, idParams),
    nodeId: node.id,
    generator: "lhPatternVariants",
    params: idParams,
    presentation: { ...lhPresentation(key, idParams, chords, seed), pattern },
    stimulus: { events: lhCountIn(tempoBpm), tempoBpm },
    display: lineScore(key, notes),
    expected: {
      play: target,
      responseWindowMs: lhResponseWindowMs(chords.length * LH_CHORD_BEATS, tempoBpm),
    },
    inputRange: lhInputRange(target.midi),
    ...latencyField(node),
  };
}

export const lhPatternVariants: Generator = {
  id: "lhPatternVariants",
  listItems(node: SkillNode): ItemParams[] {
    const p = NodeParams.parse(node.params);
    const progs = enumerateBassMotions(p.chords);
    if ("inversions" in p)
      return LH_FAMILIES.flatMap((fam) => progs.map((prog) => ({ fam, prog })));
    return LH_FAMILIES.flatMap((fam) =>
      p.patterns.flatMap((pattern) => progs.map((prog) => ({ fam, pattern, prog }))),
    );
  },
  generate(node: SkillNode, params: ItemParams, ctx: GenerateContext): ItemInstance {
    const np = NodeParams.parse(node.params);
    const { rng } = ctx;
    if ("inversions" in np) {
      // A micro-drill (T5.8, `fam|drill=IV-V`) is accepted too: the change voiced twice over.
      const ip = lhItemOf(params, { strict: true });
      checkProgression(node, np.chords, ip.prog);
      const key = keyForFamily(ip.fam, "major", ctx.preferredKey, rng);
      const seed = rng.int(0, 0x7fffffff);
      const chords = closeVoicings(key, ip.prog, np.inversions);
      return chordLineItem(node, "lhPatternVariants", ip.idParams, key, chords, seed, {
        inversions: chords.map((c) => c.inversion),
      });
    }
    const ip = PatternItemParams.parse(params);
    checkProgression(node, np.chords, ip.prog);
    if (!np.patterns.includes(ip.pattern)) {
      throw new RangeError(`pattern ${ip.pattern} is not in node ${node.id}`);
    }
    const key = keyForFamily(ip.fam, "major", ctx.preferredKey, rng);
    const seed = rng.int(0, 0x7fffffff);
    return lineItem(
      node,
      { fam: ip.fam, pattern: ip.pattern, prog: ip.prog },
      key,
      ip.pattern,
      ip.prog,
      seed,
    );
  },
};
