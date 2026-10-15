import { z } from "zod";
import type { SkillNode } from "../graph/schema.js";
import type { Duration, ScoreNote, ScoreSpec } from "../score/schema.js";
import type { StimulusEvent } from "../stimulus/types.js";
import { tonicChroma, type Key } from "../theory/keys.js";
import { latencyField } from "./build.js";
import { itemId } from "./ids.js";
import type { GenerateContext, Generator, ItemInstance, ItemParams } from "./types.js";

export interface RhythmPattern {
  id: string;
  /** Bars of 4/4 (1 or 2). */
  bars: 1 | 2;
  /** Onsets in beats from the first note (first is 0). Rests are implied by gaps. */
  onsetsBeats: readonly number[];
  /** 1 (simplest) to 5. */
  difficulty: 1 | 2 | 3 | 4 | 5;
}

const p = (
  id: string,
  bars: 1 | 2,
  difficulty: RhythmPattern["difficulty"],
  onsetsBeats: number[],
): RhythmPattern => ({ id, bars, difficulty, onsetsBeats });

/**
 * Curated patterns in 4/4, graded simple to harder. Quarter = 1 beat, eighth = 0.5, half = 2,
 * dotted quarter + eighth = onsets 0 and 1.5. A pattern is identified by its onsets only; the
 * learner is scored on timing, not note length.
 */
export const RHYTHM_PATTERNS: readonly RhythmPattern[] = [
  p("r01", 1, 1, [0, 1, 2, 3]), // four quarters
  p("r02", 1, 1, [0, 2]), // two halves
  p("r03", 1, 1, [0, 1, 2]), // quarter quarter half
  p("r04", 1, 1, [0, 2, 3]), // half quarter quarter
  p("r05", 1, 2, [0, 1, 3]), // quarter half quarter (rest on beat 3 tail)
  p("r06", 1, 2, [0, 1, 1.5, 2, 3]), // eighth pair on beat 2
  p("r07", 1, 2, [0, 1, 2, 2.5, 3]), // eighth pair on beat 3
  p("r08", 1, 2, [0, 0.5, 1, 2, 3]), // eighth pair on beat 1
  p("r09", 1, 2, [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]), // all eighths
  p("r10", 1, 3, [0, 1.5, 2, 3]), // dotted quarter + eighth, quarter, quarter
  p("r11", 1, 3, [0, 1, 2, 3.5]), // late eighth
  p("r12", 1, 3, [0, 0.5, 1.5, 2, 3]), // syncopation
  p("r13", 1, 3, [0, 1.5, 3]), // dotted quarters
  p("r14", 1, 3, [0, 0.5, 1, 1.5, 2, 3]),
  p("r15", 1, 4, [0, 1, 1.5, 2, 2.5, 3]),
  p("r16", 1, 4, [0, 1.5, 2, 3.5]),
  p("r17", 2, 3, [0, 2, 4, 6]), // four halves
  p("r18", 2, 3, [0, 1, 2, 3, 4, 6]),
  p("r19", 2, 4, [0, 1, 2, 3, 4, 4.5, 5, 6]),
  p("r20", 2, 4, [0, 1.5, 2, 3, 4, 5, 5.5, 6, 7]),
  p("r21", 2, 5, [0, 1, 2, 2.5, 3, 4, 5, 6, 6.5, 7]),
  p("r22", 2, 5, [0, 0.5, 1, 1.5, 2, 3, 4, 4.5, 5, 6]),
];

/** Note value for a gap between onsets, in beats. Other gaps cannot be written without ties. */
const GAP_DURATION: Record<string, Duration> = {
  "0.5": { value: 8, dots: 0 },
  "1": { value: 4, dots: 0 },
  "1.5": { value: 4, dots: 1 },
  "2": { value: 2, dots: 0 },
  "3": { value: 2, dots: 1 },
  "4": { value: 1, dots: 0 },
};

/**
 * Write an onsets-only pattern as notes: each note lasts until the next onset (the last until the
 * end of the bar). Undefined when a gap has no single written value or a note would cross a barline.
 */
export function rhythmStaff(
  pat: Pick<RhythmPattern, "bars" | "onsetsBeats">,
): ScoreSpec | undefined {
  const total = pat.bars * BEATS_PER_BAR;
  const measures: ScoreNote[][] = Array.from({ length: pat.bars }, () => []);
  let n = 0;
  for (const [i, onset] of pat.onsetsBeats.entries()) {
    const gap = (pat.onsetsBeats[i + 1] ?? total) - onset;
    const duration = GAP_DURATION[String(gap)];
    const bar = Math.floor(onset / BEATS_PER_BAR);
    if (duration === undefined || onset + gap > (bar + 1) * BEATS_PER_BAR) return undefined;
    measures[bar]?.push({
      kind: "note",
      id: "n" + String(++n),
      pitches: [{ step: "B", alter: 0, octave: 4 }],
      duration: { ...duration },
    });
  }
  if (pat.onsetsBeats[0] !== 0 || measures.some((m) => m.length === 0)) return undefined;
  return {
    staves: [{ clef: "percussion", lines: 1, measures }],
    key: null,
    meter: { beats: BEATS_PER_BAR, beatValue: 4 },
  };
}

const RhythmNodeParams = z.object({
  bars: z.array(z.int().min(1).max(2)).min(1),
  meter: z.literal("4/4"),
  tempoRangeBpm: z.tuple([z.int().positive(), z.int().positive()]).optional(),
});
const RhythmItemParams = z.object({ pattern: z.string() });

export const DEFAULT_TEMPO_RANGE: readonly [number, number] = [80, 100];
export const COUNT_IN_PITCH = 84;
export const COUNT_IN_VELOCITY = 0.4;
/** The rhythm's note when no key is given: middle C. */
export const RHYTHM_PITCH = 60;

/**
 * The rhythm sounds on the tonic of the key of the day (middle C up to the B above it), so even
 * a rhythm exercise keeps the key in the ear.
 */
export function rhythmPitch(key?: Key): number {
  return key === undefined ? RHYTHM_PITCH : RHYTHM_PITCH + tonicChroma(key);
}
export const BEATS_PER_BAR = 4;

/**
 * Rhythm echo: 4 count-in clicks, then the pattern on one pitch. Exception to spec 2: no cadence,
 * because rhythm has no tonal context to establish.
 */
export const rhythmEcho: Generator = {
  id: "rhythmEcho",
  listItems(node: SkillNode): ItemParams[] {
    const np = RhythmNodeParams.parse(node.params);
    return RHYTHM_PATTERNS.filter((r) => np.bars.includes(r.bars)).map((r) => ({ pattern: r.id }));
  },
  generate(node: SkillNode, params: ItemParams, ctx: GenerateContext): ItemInstance {
    const np = RhythmNodeParams.parse(node.params);
    const { pattern: patternId } = RhythmItemParams.parse(params);
    const pat = RHYTHM_PATTERNS.find((r) => r.id === patternId);
    if (pat === undefined || !np.bars.includes(pat.bars))
      throw new RangeError(`unknown rhythm pattern ${patternId} for node ${node.id}`);
    const { rng } = ctx;
    const [lo, hi] = np.tempoRangeBpm ?? DEFAULT_TEMPO_RANGE;
    // Tempo in steps of 5 bpm within the range.
    const tempoBpm = rng.int(Math.ceil(lo / 5), Math.floor(hi / 5)) * 5;
    const seed = rng.int(0, 0x7fffffff);
    const beatSec = 60 / tempoBpm;
    const pitch = rhythmPitch(ctx.preferredKey);

    const events: StimulusEvent[] = [];
    for (let i = 0; i < BEATS_PER_BAR; i++) {
      events.push({
        atSec: i * beatSec,
        midi: [COUNT_IN_PITCH],
        durationSec: 0.1,
        velocity: COUNT_IN_VELOCITY,
        role: "count-in",
      });
    }
    const start = BEATS_PER_BAR * beatSec;
    for (const b of pat.onsetsBeats) {
      events.push({
        atSec: start + b * beatSec,
        midi: [pitch],
        durationSec: beatSec * 0.4,
        velocity: 0.8,
        role: "target",
      });
    }

    const staff = rhythmStaff(pat);
    return {
      itemId: itemId(node.id, { pattern: pat.id }),
      nodeId: node.id,
      generator: "rhythmEcho",
      params: { pattern: pat.id },
      presentation: {
        pattern: pat.id,
        onsetsBeats: [...pat.onsetsBeats],
        tempoBpm,
        beatsPerBar: BEATS_PER_BAR,
        pitch,
        seed,
      },
      stimulus: { events, tempoBpm },
      expected: {
        play: {
          kind: "rhythm",
          onsetsBeats: [...pat.onsetsBeats],
          tempoBpm,
          beatsPerBar: BEATS_PER_BAR,
          pitch,
        },
        responseWindowMs: 12000,
      },
      ...(staff ? { staff } : {}),
      ...latencyField(node),
    };
  },
};
