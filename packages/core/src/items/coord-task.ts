import { z } from "zod";
import type { SkillNode } from "../graph/schema.js";
import { createRng } from "../random.js";
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
import { positionInKey, stepOffset, type StaffPosition } from "../theory/staff.js";
import { at } from "../theory/util.js";
import { enumerateBassMotions } from "./bass-motion.js";
import { keyToJson, latencyField } from "./build.js";
import type { PerformanceTarget } from "./expected.js";
import { keyForFamily } from "./family.js";
import { itemId } from "./ids.js";
import {
  LH_KEYBOARD_MARGIN,
  LH_TEMPO_BPM,
  lhChords,
  lhResponseWindowMs,
  type LhChord,
} from "./lh-pattern.js";
import { COUNT_IN_PITCH, COUNT_IN_VELOCITY } from "./rhythm.js";
import type { GenerateContext, Generator, ItemInstance, ItemParams } from "./types.js";

/*
 * Hands together over block chords (T5.5, spec 7 `coordTask`, node hands.coord.basic). One item is
 * four bars of 4/4 on a grand staff: the left hand holds one root-position triad per bar as a whole
 * note (the `lhPattern` voicing, C2 to C4), and the right hand plays a quarter-note melody in a
 * five-finger position on the tonic (degrees 1 to 5, inside C4 to G5) with a chord tone on beats 1
 * and 3. Played after a one-bar count-in at 60 bpm and graded as a `performance` (R27), so it needs
 * polyphonic input: the composer only offers it with MIDI.
 *
 * Identity (R1, R15): `nodeId|fam=A|mel=2|prog=I-IV-V-I`. The progression universe is the
 * `bassMotion` one; each progression has `COORD_MELODIES` melodies. A melody is a pure function of
 * the progression and its number, written in scale degrees, so the same item has the same tune in
 * every key. The key is presentation.
 */

/** Melodies per progression. */
export const COORD_MELODIES = 3;
/** Bars per item, one chord each. */
export const COORD_BARS = 4;
const BEATS_PER_BAR = 4;
/** The right hand's register: C4 to G5. */
export const RH_RANGE: VoiceRange = { low: 60, high: 79 };
/**
 * The melody's scale degrees above the tonic, 0 to 4: a five-finger position (degrees 1 to 5), so
 * the right hand never has to shift. Every chord of I, IV, V and vi has at least two tones in it.
 */
const TOP_DEGREE = 4;

const FAMILIES: readonly KeyFamily[] = ["A", "B", "C"];
const STEPS: readonly Step[] = ["C", "D", "E", "F", "G", "A", "B"];

const CoordNodeParams = z.object({
  rh: z.literal("melody"),
  lh: z.literal("block"),
  chords: z
    .array(z.string().refine((r) => MAJOR_ROMANS.includes(r), "unknown major Roman numeral"))
    .min(2),
});
const CoordItemParams = z.object({
  fam: z.enum(["A", "B", "C"]),
  prog: z.array(z.string()).length(COORD_BARS),
  mel: z.int().min(1).max(COORD_MELODIES),
});

/** Scale degrees (0 = tonic) of a chord's tones that lie in the five-finger position. */
export function chordDegrees(roman: string): number[] {
  const root = MAJOR_ROMAN_ROOTS[roman];
  if (root === undefined) throw new RangeError(`unknown Roman numeral: ${roman}`);
  return [0, 2, 4]
    .map((third) => (root - 1 + third) % 7)
    .filter((d) => d <= TOP_DEGREE)
    .sort((a, b) => a - b);
}

/** FNV-1a, so a progression seeds its own melodies whatever the session's random state. */
function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Every sequence of strong-beat degrees (beats 1 and 3 of each bar) for `prog`: each a chord tone
 * of its bar's chord, starting on a tone of I, no more than a third from the one before, spanning
 * at least a third, and never the same degree three strong beats running. In a stable order.
 */
function strongLines(prog: readonly string[]): number[][] {
  const tones = prog.map(chordDegrees);
  const out: number[][] = [];
  const rec = (line: number[]): void => {
    const i = line.length;
    if (i === prog.length * 2) {
      if (Math.max(...line) - Math.min(...line) >= 2) out.push(line);
      return;
    }
    for (const d of at(tones, Math.floor(i / 2))) {
      const prev = line[i - 1];
      if (prev !== undefined && Math.abs(d - prev) > 2) continue;
      if (prev !== undefined && line[i - 2] === prev && d === prev) continue;
      rec([...line, d]);
    }
  };
  rec([]);
  return out;
}

/** The weak-beat degree between two strong ones, by step: a passing, neighbour or repeated note. */
function weakBetween(a: number, b: number, pick: (options: number[]) => number): number {
  if (Math.abs(a - b) === 2) return (a + b) / 2;
  if (a === b) return pick([a - 1, a + 1].filter((d) => d >= 0 && d <= TOP_DEGREE));
  return pick([a, b]);
}

/**
 * The right hand's melody for a progression, as 16 scale degrees (0 = tonic) in quarter notes. A
 * pure function of `prog` and `mel` (1 to `COORD_MELODIES`); the melodies of one progression
 * differ. Beats 1 and 3 are chord tones; beats 2 and 4 move by step to the next strong beat (a
 * passing, neighbour or repeated note), and the last note is a chord tone of the last chord.
 */
export function coordMelody(prog: readonly string[], mel: number): number[] {
  if (!Number.isInteger(mel) || mel < 1 || mel > COORD_MELODIES) {
    throw new RangeError(`melody ${String(mel)} is not 1 to ${String(COORD_MELODIES)}`);
  }
  const rng = createRng(hashString(prog.join("-")));
  const pick = (options: number[]): number => rng.pick(options);
  const lines = strongLines(prog);
  if (lines.length < COORD_MELODIES) {
    throw new RangeError(`too few melodies for ${prog.join("-")}`);
  }
  // Draw distinct strong-beat lines in turn; melody `mel` is the mel-th one drawn.
  const chosen: number[][] = [];
  const remaining = [...lines];
  while (chosen.length < mel) {
    const i = rng.int(0, remaining.length - 1);
    chosen.push(at(remaining, i));
    remaining.splice(i, 1);
  }
  const strong = at(chosen, mel - 1);
  const melody: number[] = [];
  strong.forEach((s, i) => {
    melody.push(s);
    const next = strong[i + 1];
    if (next !== undefined) {
      melody.push(weakBetween(s, next, pick));
    } else {
      // The last beat: a chord tone of the last chord, by step or a third, a different note when
      // one is that close.
      const lastTones = chordDegrees(at(prog, prog.length - 1));
      const moves = lastTones.filter((d) => d !== s && Math.abs(d - s) <= 2);
      melody.push(moves.length > 0 ? pick(moves) : s);
    }
  });
  return melody;
}

/**
 * The tonic of the five-finger position: the lowest tonic from C4 up that lies above every
 * left-hand note, so the hands never share a key. The left hand reaches C4 at most, so the top of
 * the position (the fifth above) stays at or below G5.
 */
function rhTonic(key: Key, lhTop: number): StaffPosition {
  const step = key.tonic.charAt(0) as Step;
  if (!STEPS.includes(step)) throw new RangeError(`bad tonic ${key.tonic}`);
  for (let octave = 3; octave <= 6; octave++) {
    const pos = { step, octave };
    const { midi } = positionInKey(pos, key);
    if (midi >= RH_RANGE.low && midi > lhTop) return pos;
  }
  throw new RangeError(`no right-hand position for ${key.tonic}`);
}

/** The melody spelled in `key` above the left hand's chords. */
export function coordMelodyPitches(
  key: Key,
  degrees: readonly number[],
  chords: readonly LhChord[],
): SpelledPitch[] {
  const tonic = rhTonic(key, Math.max(...chords.flatMap((c) => c.midi)));
  return degrees.map((d) => positionInKey(stepOffset(tonic, d), key).pitch);
}

function scoreOf(key: Key, melody: readonly SpelledPitch[], chords: readonly LhChord[]): ScoreSpec {
  const rhNotes: ScoreNote[] = melody.map((p, i) => ({
    kind: "note",
    id: `n${String(i + 1)}`,
    pitches: [p],
    duration: { value: 4, dots: 0 },
  }));
  const treble: ScoreNote[][] = [];
  for (let i = 0; i < rhNotes.length; i += BEATS_PER_BAR) {
    treble.push(rhNotes.slice(i, i + BEATS_PER_BAR));
  }
  // Every tone is diatonic, so the key signature covers it and no accidental is written.
  const bass: ScoreNote[][] = chords.map((c, i) => [
    {
      kind: "note",
      id: `n${String(rhNotes.length + i + 1)}`,
      pitches: c.pitches,
      duration: { value: 1, dots: 0 },
    },
  ]);
  return {
    staves: [
      { clef: "treble", lines: 5, measures: treble },
      { clef: "bass", lines: 5, measures: bass },
    ],
    key: { tonic: key.tonic, mode: key.mode },
    meter: { beats: BEATS_PER_BAR, beatValue: 4 },
  };
}

/**
 * The notes of both hands as the scorer expects them: the ids of `scoreOf` (a chord tone `n17.1`,
 * as `expectedFromScore` names them), in onset order with the right hand first at each onset.
 */
function performanceOf(
  melodyMidi: readonly number[],
  chords: readonly LhChord[],
): PerformanceTarget {
  const notes: PerformanceTarget["notes"] = [];
  chords.forEach((c, bar) => {
    for (let beat = 0; beat < BEATS_PER_BAR; beat++) {
      const i = bar * BEATS_PER_BAR + beat;
      notes.push({
        id: `n${String(i + 1)}`,
        midi: at(melodyMidi, i),
        onsetBeats: i,
        durationBeats: 1,
        hand: "rh",
      });
      if (beat === 0) {
        c.midi.forEach((midi, tone) => {
          notes.push({
            id: `n${String(melodyMidi.length + bar + 1)}.${String(tone)}`,
            midi,
            onsetBeats: i,
            durationBeats: BEATS_PER_BAR,
            hand: "lh",
          });
        });
      }
    }
  });
  return { kind: "performance", notes, tempoBpm: LH_TEMPO_BPM, beatsPerBar: BEATS_PER_BAR };
}

export const coordTask: Generator = {
  id: "coordTask",
  listItems(node: SkillNode): ItemParams[] {
    const p = CoordNodeParams.parse(node.params);
    const progs = enumerateBassMotions(p.chords);
    const mels = Array.from({ length: COORD_MELODIES }, (_, i) => i + 1);
    return FAMILIES.flatMap((fam) =>
      progs.flatMap((prog) => mels.map((mel) => ({ fam, prog, mel }))),
    );
  },
  generate(node: SkillNode, params: ItemParams, ctx: GenerateContext): ItemInstance {
    const np = CoordNodeParams.parse(node.params);
    const ip = CoordItemParams.parse(params);
    if (ip.prog.some((c) => !np.chords.includes(c))) {
      throw new RangeError(`progression ${ip.prog.join("-")} uses a chord not in node ${node.id}`);
    }
    const { rng } = ctx;
    const key = keyForFamily(ip.fam, "major", ctx.preferredKey, rng);
    const seed = rng.int(0, 0x7fffffff);
    const chords = lhChords(key, ip.prog);
    const degrees = coordMelody(ip.prog, ip.mel);
    const melody = coordMelodyPitches(key, degrees, chords);
    const target = performanceOf(melody.map(spelledToMidi), chords);
    const tempoBpm = LH_TEMPO_BPM;
    const beatSec = 60 / tempoBpm;
    const countIn: StimulusEvent[] = Array.from({ length: BEATS_PER_BAR }, (_, i) => ({
      atSec: i * beatSec,
      midi: [COUNT_IN_PITCH],
      durationSec: 0.1,
      velocity: COUNT_IN_VELOCITY,
      role: "count-in" as const,
    }));
    const all = target.notes.map((n) => n.midi);
    const idParams: ItemParams = { fam: ip.fam, prog: ip.prog, mel: ip.mel };
    return {
      itemId: itemId(node.id, idParams),
      nodeId: node.id,
      generator: "coordTask",
      params: idParams,
      presentation: {
        key: keyToJson(key),
        tonic: key.tonic,
        mode: key.mode,
        fam: ip.fam,
        prog: ip.prog,
        mel: ip.mel,
        chords: chords.map((c) => c.midi),
        symbols: chords.map((c) => c.symbol),
        melody: target.notes.filter((n) => n.hand === "rh").map((n) => n.midi),
        tempoBpm,
        seed,
      },
      stimulus: { events: countIn, tempoBpm },
      display: scoreOf(key, melody, chords),
      expected: {
        play: target,
        responseWindowMs: lhResponseWindowMs(COORD_BARS * BEATS_PER_BAR, tempoBpm),
      },
      inputRange: {
        low: Math.min(...all) - LH_KEYBOARD_MARGIN,
        high: Math.max(...all) + LH_KEYBOARD_MARGIN,
      },
      ...latencyField(node),
    };
  },
};
