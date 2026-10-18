import { z } from "zod";
import type { SkillNode } from "../graph/schema.js";
import { spelledToMidi, type ScoreSpec, type SpelledPitch, type Step } from "../score/schema.js";
import { MAJOR_ROMAN_ROOTS } from "../theory/cadence.js";
import type { Key, KeyFamily } from "../theory/keys.js";
import {
  formatStaffPosition,
  positionInKey,
  staffPosition,
  stepOffset,
  writtenAccidental,
  type StaffPosition,
} from "../theory/staff.js";
import { at } from "../theory/util.js";
import { BASS_READ_RANGE } from "./bass-note-read.js";
import { keyToJson, latencyField } from "./build.js";
import type { ChordLineTarget } from "./expected.js";
import { keyForFamily } from "./family.js";
import { itemId } from "./ids.js";
import type { GenerateContext, Generator, ItemInstance, ItemParams } from "./types.js";

/*
 * Bass chord reading (T5.10, spec 7 `bassChordRead`, node read.bass.chords). One major or minor
 * triad in root position, first or second inversion, written as a whole-note chord on the bass
 * staff with no sound first. The learner plays it as a block chord on a MIDI keyboard. The answer
 * is a one-chord `chordLine` graded on the tones only (`gradeTiming: false`), and its numeral and
 * symbol are hidden while playing (`showLabels: false`), because reading the chord is the task.
 * Latency runs from the moment the score is shown (R17).
 *
 * Identity (R1, R15): `nodeId|fam=A|inv=first|roman=ii`. The chord is named by its numeral in the
 * key, so the key itself is presentation, as for the other reading nodes. Major triads are I, IV
 * and V and minor ones ii, iii and vi: the diatonic triads of a major key, so every tone takes its
 * alteration from the key signature and no accidental is written. The register is presentation
 * too: a seeded pick among the octaves that keep the whole chord between `CHORD_STAFF_LOW` and
 * `CHORD_STAFF_HIGH`.
 */

/** Lowest staff position a chord tone may sit on: E2, one ledger line below the bass staff. */
export const CHORD_STAFF_LOW: StaffPosition = { step: "E", octave: 2 };
/** Highest staff position a chord tone may sit on: middle C, one ledger line above. */
export const CHORD_STAFF_HIGH: StaffPosition = { step: "C", octave: 4 };

/** How long the learner has, from the score being shown, before the item times out. */
export const BASS_CHORD_WINDOW_MS = 10000;
/** Nominal tempo of the one-chord line. Timing is not graded, so it only sizes the whole note. */
const CHORD_TEMPO_BPM = 60;
const BEATS_PER_BAR = 4;

const FAMILIES: readonly KeyFamily[] = ["A", "B", "C"];
const STEPS: readonly Step[] = ["C", "D", "E", "F", "G", "A", "B"];

export type BassChordQuality = "major" | "minor";
export type BassChordInversion = "root" | "first" | "second";

/** The diatonic triads of a major key by quality (vii diminished is not part of the node). */
export const ROMANS_BY_QUALITY: Readonly<Record<BassChordQuality, readonly string[]>> = {
  major: ["I", "IV", "V"],
  minor: ["ii", "iii", "vi"],
};

/**
 * Staff steps above the bass note of each chord tone, lowest first: root position is root, third,
 * fifth; first inversion third, fifth, root; second inversion fifth, root, third.
 */
const INVERSION_STEPS: Readonly<Record<BassChordInversion, readonly [number, number, number]>> = {
  root: [0, 2, 4],
  first: [0, 2, 5],
  second: [0, 3, 5],
};
/** Staff steps from the root up to the bass note of each inversion. */
const BASS_ABOVE_ROOT: Readonly<Record<BassChordInversion, number>> = {
  root: 0,
  first: 2,
  second: 4,
};

const QUALITIES = ["major", "minor"] as const;
const INVERSIONS = ["root", "first", "second"] as const;

const NodeParams = z.object({
  clef: z.literal("bass"),
  qualities: z.array(z.enum(QUALITIES)).min(1),
  inversions: z.array(z.enum(INVERSIONS)).min(1),
});
const ItemParamsSchema = z.object({
  fam: z.enum(["A", "B", "C"]),
  roman: z.string(),
  inv: z.enum(INVERSIONS),
});

const qualityOf = (roman: string): BassChordQuality =>
  roman === roman.toLowerCase() ? "minor" : "major";

/** One chord of an item: its numeral, symbol, spelled tones (lowest first) and positions. */
export interface BassChord {
  roman: string;
  inversion: BassChordInversion;
  /** "F", "Am", and with the bass after a slash when inverted: "F/A", "Am/C". */
  symbol: string;
  positions: StaffPosition[];
  pitches: SpelledPitch[];
  midi: number[];
}

function noteName(p: SpelledPitch): string {
  return `${p.step}${p.alter > 0 ? "#".repeat(p.alter) : "b".repeat(-p.alter)}`;
}

/**
 * The bass positions of `roman` in `inversion` in a major `key` that keep every chord tone inside
 * `CHORD_STAFF_LOW` to `CHORD_STAFF_HIGH`, lowest first.
 */
export function bassChordRegisters(
  key: Key,
  roman: string,
  inversion: BassChordInversion,
): StaffPosition[] {
  const degree = MAJOR_ROMAN_ROOTS[roman];
  if (degree === undefined) throw new RangeError(`unknown Roman numeral: ${roman}`);
  const tonicLetter = STEPS.indexOf(key.tonic.charAt(0) as Step);
  if (tonicLetter < 0) throw new RangeError(`bad tonic ${key.tonic}`);
  const bassLetter = at(STEPS, (tonicLetter + degree - 1 + BASS_ABOVE_ROOT[inversion]) % 7);
  const steps = INVERSION_STEPS[inversion];
  const lo = staffPosition(CHORD_STAFF_LOW);
  const hi = staffPosition(CHORD_STAFF_HIGH);
  const out: StaffPosition[] = [];
  for (let octave = 0; octave <= 8; octave++) {
    const bass = { step: bassLetter, octave };
    const i = staffPosition(bass);
    if (i >= lo && i + at(steps, 2) <= hi) out.push(bass);
  }
  return out;
}

/** The chord `roman` in `inversion` in a major `key`, with its bass note on `bass`. */
export function bassChord(
  key: Key,
  roman: string,
  inversion: BassChordInversion,
  bass: StaffPosition,
): BassChord {
  if (key.mode !== "major") throw new RangeError("bassChord supports major keys only");
  const positions = INVERSION_STEPS[inversion].map((n) => stepOffset(bass, n));
  const pitches = positions.map((p) => positionInKey(p, key).pitch);
  // The root is the bass in root position, the top note in first and the middle in second.
  const rootIndex = { root: 0, first: 2, second: 1 }[inversion];
  const root = at(pitches, rootIndex);
  const name = `${noteName(root)}${qualityOf(roman) === "minor" ? "m" : ""}`;
  return {
    roman,
    inversion,
    symbol: inversion === "root" ? name : `${name}/${noteName(at(pitches, 0))}`,
    positions,
    pitches,
    midi: pitches.map(spelledToMidi),
  };
}

function scoreOf(key: Key, chord: BassChord): ScoreSpec {
  const accidental = chord.pitches
    .map((p) => writtenAccidental(p, key))
    .find((a) => a !== undefined);
  return {
    staves: [
      {
        clef: "bass",
        lines: 5,
        measures: [
          [
            {
              kind: "note",
              id: "n1",
              pitches: chord.pitches,
              duration: { value: 1, dots: 0 },
              ...(accidental === undefined ? {} : { accidental }),
            },
          ],
        ],
      },
    ],
    key: { tonic: key.tonic, mode: key.mode },
    meter: null,
  };
}

export const bassChordRead: Generator = {
  id: "bassChordRead",
  listItems(node: SkillNode): ItemParams[] {
    const p = NodeParams.parse(node.params);
    const out: ItemParams[] = [];
    for (const fam of FAMILIES)
      for (const quality of p.qualities)
        for (const roman of ROMANS_BY_QUALITY[quality])
          for (const inv of p.inversions) out.push({ fam, roman, inv });
    return out;
  },
  generate(node: SkillNode, params: ItemParams, ctx: GenerateContext): ItemInstance {
    const np = NodeParams.parse(node.params);
    const ip = ItemParamsSchema.parse(params);
    const quality = MAJOR_ROMAN_ROOTS[ip.roman] === undefined ? undefined : qualityOf(ip.roman);
    if (
      quality === undefined ||
      !np.qualities.includes(quality) ||
      !ROMANS_BY_QUALITY[quality].includes(ip.roman) ||
      !np.inversions.includes(ip.inv)
    ) {
      throw new RangeError(`chord ${ip.roman} ${ip.inv} is not in node ${node.id}`);
    }
    const { rng } = ctx;
    const key = keyForFamily(ip.fam, "major", ctx.preferredKey, rng);
    const bass = rng.pick(bassChordRegisters(key, ip.roman, ip.inv));
    const seed = rng.int(0, 0x7fffffff);
    const chord = bassChord(key, ip.roman, ip.inv, bass);
    const target: ChordLineTarget = {
      kind: "chordLine",
      chords: [
        {
          roman: chord.roman,
          symbol: chord.symbol,
          midi: chord.midi,
          onsetBeats: 0,
          durationBeats: BEATS_PER_BAR,
        },
      ],
      tempoBpm: CHORD_TEMPO_BPM,
      beatsPerBar: BEATS_PER_BAR,
      gradeTiming: false,
      showLabels: false,
    };
    const idParams: ItemParams = { fam: ip.fam, roman: ip.roman, inv: ip.inv };
    return {
      itemId: itemId(node.id, idParams),
      nodeId: node.id,
      generator: "bassChordRead",
      params: idParams,
      presentation: {
        key: keyToJson(key),
        tonic: key.tonic,
        mode: key.mode,
        fam: ip.fam,
        clef: "bass",
        bass: formatStaffPosition(bass),
        midi: chord.midi,
        // One-chord forms of the chord line fields, so the answer line can name the chord.
        prog: [chord.roman],
        symbols: [chord.symbol],
        seed,
      },
      stimulus: { events: [] },
      display: scoreOf(key, chord),
      expected: { play: target, responseWindowMs: BASS_CHORD_WINDOW_MS },
      inputRange: {
        low: Math.min(BASS_READ_RANGE.low, ...chord.midi),
        high: Math.max(BASS_READ_RANGE.high, ...chord.midi),
      },
      ...latencyField(node),
    };
  },
};
