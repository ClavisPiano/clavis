import { z } from "zod";
import type { SkillNode } from "../graph/schema.js";
import {
  spelledToMidi,
  type ScoreNote,
  type ScoreSpec,
  type SpelledPitch,
  type Step,
} from "../score/schema.js";
import type { StimulusEvent } from "../stimulus/types.js";
import { MAJOR_ROMANS, MAJOR_ROMAN_ROOTS } from "../theory/cadence.js";
import type { Key, KeyFamily, VoiceRange } from "../theory/keys.js";
import {
  positionInKey,
  stepOffset,
  writtenAccidental,
  type StaffPosition,
} from "../theory/staff.js";
import { at } from "../theory/util.js";
import { enumerateBassMotions } from "./bass-motion.js";
import { keyToJson, latencyField } from "./build.js";
import type { ChordLineTarget } from "./expected.js";
import { keyForFamily } from "./family.js";
import { itemId } from "./ids.js";
import { COUNT_IN_PITCH, COUNT_IN_VELOCITY } from "./rhythm.js";
import type { GenerateContext, Generator, ItemInstance, ItemParams } from "./types.js";

/*
 * Left-hand block chords (T5.3, spec 7 `lhPattern`, node hands.lh.triads.root). One item is a
 * progression of four root-position triads from the node's chords, written on the bass staff as
 * half-note chords over two bars and played as block chords after a one-bar count-in. Graded by
 * performance alignment (`chordLine`), so it needs polyphonic input: the composer only offers it
 * when the session's input is MIDI.
 *
 * Identity (R1, R15): `nodeId|fam=A|prog=I-IV-V-I`. The key is never part of the id; the family
 * is, as for the reading nodes, because the node is key dependent. The progression universe is the
 * one `bassMotion` uses: four chords that start on I and never repeat a chord twice running.
 */

/** The left-hand register: C2 to C4. */
export const LH_RANGE: VoiceRange = { low: 36, high: 60 };
/**
 * Lowest and highest root. A root-position triad spans a perfect fifth or less, so a root no
 * higher than F3 keeps the whole chord inside `LH_RANGE`.
 */
export const LH_ROOT_RANGE: VoiceRange = { low: 36, high: 53 };
/** Where the first chord's root sits: the root nearest this is chosen. */
const LH_ROOT_CENTRE = 45;

/** Slow and steady: the learner reads chords and finds them, so the pulse is gentle. */
export const LH_TEMPO_BPM = 60;
/** Beats each chord is held (a half note in 4/4). */
export const LH_CHORD_BEATS = 2;
const BEATS_PER_BAR = 4;

/** Room either side of the chords on the on-screen keyboard, in semitones. */
export const LH_KEYBOARD_MARGIN = 4;

const FAMILIES: readonly KeyFamily[] = ["A", "B", "C"];
const STEPS: readonly Step[] = ["C", "D", "E", "F", "G", "A", "B"];

const LhNodeParams = z.object({
  pattern: z.literal("block"),
  chords: z
    .array(z.string().refine((r) => MAJOR_ROMANS.includes(r), "unknown major Roman numeral"))
    .min(2),
  inversion: z.literal("root"),
});
const LhItemParams = z.object({
  fam: z.enum(["A", "B", "C"]),
  prog: z.array(z.string()).length(4),
});

/**
 * How long the learner has to play the progression, after the count-in, before it times out: the
 * progression twice over, plus time to find the first chord.
 */
export function lhResponseWindowMs(totalBeats: number, tempoBpm: number): number {
  const beatMs = 60000 / tempoBpm;
  return Math.round(Math.max(15000, totalBeats * beatMs * 2 + 8000));
}

/** One chord of an item: its numeral, symbol and spelled tones, lowest first. */
export interface LhChord {
  roman: string;
  symbol: string;
  pitches: SpelledPitch[];
  midi: number[];
}

/** "F", "F#", "Bb" with "m" for a minor triad, for example "Am". */
function chordSymbol(root: SpelledPitch, minor: boolean): string {
  const acc = root.alter > 0 ? "#".repeat(root.alter) : "b".repeat(-root.alter);
  return `${root.step}${acc}${minor ? "m" : ""}`;
}

/**
 * Root-position triads for `prog` in a major `key`, with each root in `LH_ROOT_RANGE` nearest the
 * previous root (the first nearest the middle of the range), so the hand moves little. Every tone
 * is diatonic, so the key signature gives each its alteration and no accidental is written.
 */
export function lhChords(key: Key, prog: readonly string[]): LhChord[] {
  if (key.mode !== "major") throw new RangeError("lhChords supports major keys only");
  const tonicLetter = STEPS.indexOf(key.tonic.charAt(0) as Step);
  if (tonicLetter < 0) throw new RangeError(`bad tonic ${key.tonic}`);
  let prev = LH_ROOT_CENTRE;
  return prog.map((roman): LhChord => {
    const degree = MAJOR_ROMAN_ROOTS[roman];
    if (degree === undefined) throw new RangeError(`unknown Roman numeral: ${roman}`);
    const step = at(STEPS, (tonicLetter + degree - 1) % 7);
    let best: { pos: StaffPosition; midi: number } | undefined;
    for (let octave = 0; octave <= 8; octave++) {
      const pos = { step, octave };
      const { midi } = positionInKey(pos, key);
      if (midi < LH_ROOT_RANGE.low || midi > LH_ROOT_RANGE.high) continue;
      if (best === undefined || Math.abs(midi - prev) < Math.abs(best.midi - prev)) {
        best = { pos, midi };
      }
    }
    if (best === undefined) throw new RangeError(`no root for ${roman} in ${key.tonic}`);
    prev = best.midi;
    const positions = [best.pos, stepOffset(best.pos, 2), stepOffset(best.pos, 4)];
    const pitches = positions.map((p) => positionInKey(p, key).pitch);
    return {
      roman,
      // Lower case numerals are minor triads.
      symbol: chordSymbol(at(pitches, 0), roman === roman.toLowerCase()),
      pitches,
      midi: pitches.map(spelledToMidi),
    };
  });
}

function scoreOf(key: Key, chords: readonly LhChord[]): ScoreSpec {
  const notes: ScoreNote[] = chords.map((c, i) => {
    const accidental = c.pitches.map((p) => writtenAccidental(p, key)).find((a) => a !== undefined);
    return {
      kind: "note",
      id: `n${String(i + 1)}`,
      pitches: c.pitches,
      duration: { value: 2, dots: 0 },
      ...(accidental === undefined ? {} : { accidental }),
    };
  });
  const perBar = BEATS_PER_BAR / LH_CHORD_BEATS;
  const measures: ScoreNote[][] = [];
  for (let i = 0; i < notes.length; i += perBar) measures.push(notes.slice(i, i + perBar));
  return {
    staves: [{ clef: "bass", lines: 5, measures }],
    key: { tonic: key.tonic, mode: key.mode },
    meter: { beats: BEATS_PER_BAR, beatValue: 4 },
  };
}

export const lhPattern: Generator = {
  id: "lhPattern",
  listItems(node: SkillNode): ItemParams[] {
    const p = LhNodeParams.parse(node.params);
    const progs = enumerateBassMotions(p.chords);
    return FAMILIES.flatMap((fam) => progs.map((prog) => ({ fam, prog })));
  },
  generate(node: SkillNode, params: ItemParams, ctx: GenerateContext): ItemInstance {
    const np = LhNodeParams.parse(node.params);
    const ip = LhItemParams.parse(params);
    if (ip.prog.some((c) => !np.chords.includes(c))) {
      throw new RangeError(`progression ${ip.prog.join("-")} uses a chord not in node ${node.id}`);
    }
    const { rng } = ctx;
    const key = keyForFamily(ip.fam, "major", ctx.preferredKey, rng);
    const seed = rng.int(0, 0x7fffffff);
    const chords = lhChords(key, ip.prog);
    const tempoBpm = LH_TEMPO_BPM;
    const beatSec = 60 / tempoBpm;

    const countIn: StimulusEvent[] = Array.from({ length: BEATS_PER_BAR }, (_, i) => ({
      atSec: i * beatSec,
      midi: [COUNT_IN_PITCH],
      durationSec: 0.1,
      velocity: COUNT_IN_VELOCITY,
      role: "count-in" as const,
    }));
    const target: ChordLineTarget = {
      kind: "chordLine",
      chords: chords.map((c, i) => ({
        roman: c.roman,
        symbol: c.symbol,
        midi: c.midi,
        onsetBeats: i * LH_CHORD_BEATS,
        durationBeats: LH_CHORD_BEATS,
      })),
      tempoBpm,
      beatsPerBar: BEATS_PER_BAR,
    };
    const all = chords.flatMap((c) => c.midi);
    const idParams: ItemParams = { fam: ip.fam, prog: ip.prog };
    return {
      itemId: itemId(node.id, idParams),
      nodeId: node.id,
      generator: "lhPattern",
      params: idParams,
      presentation: {
        key: keyToJson(key),
        tonic: key.tonic,
        mode: key.mode,
        fam: ip.fam,
        prog: ip.prog,
        chords: chords.map((c) => c.midi),
        symbols: chords.map((c) => c.symbol),
        tempoBpm,
        seed,
      },
      stimulus: { events: countIn, tempoBpm },
      display: scoreOf(key, chords),
      expected: {
        play: target,
        responseWindowMs: lhResponseWindowMs(chords.length * LH_CHORD_BEATS, tempoBpm),
      },
      inputRange: {
        low: Math.min(...all) - LH_KEYBOARD_MARGIN,
        high: Math.max(...all) + LH_KEYBOARD_MARGIN,
      },
      ...latencyField(node),
    };
  },
};
