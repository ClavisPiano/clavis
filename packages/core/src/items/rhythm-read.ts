import { z } from "zod";
import type { SkillNode } from "../graph/schema.js";
import type { Duration, ScoreNote, ScoreSpec } from "../score/schema.js";
import type { StimulusEvent } from "../stimulus/types.js";
import { latencyField } from "./build.js";
import { itemId } from "./ids.js";
import { BEATS_PER_BAR, COUNT_IN_PITCH, COUNT_IN_VELOCITY } from "./rhythm.js";
import type { GenerateContext, Generator, ItemInstance, ItemParams } from "./types.js";

/** Names used by the `values` param of `read.rhythm.basic`. */
export type RhythmValue = "half" | "quarter" | "eighth" | "dotted-quarter" | "tie";

export interface ReadRhythm {
  id: string;
  /** Bars of 4/4 (1 or 2). */
  bars: 1 | 2;
  /** Notes as written, bar by bar, with ties. Every note sounds (no rests). */
  measures: readonly (readonly Duration[])[];
  /** Note values the pattern needs, as named by the node's `values` param. */
  values: readonly RhythmValue[];
  /** Onsets in beats from the first note; a tie continuation adds none. */
  onsetsBeats: readonly number[];
  /** 1 (simplest) to 5. */
  difficulty: 1 | 2 | 3 | 4 | 5;
}

/** Length of a duration in quarter-note beats: 4 / value, times 1.5 when dotted. */
export function durationBeats(d: Duration): number {
  return (4 / d.value) * (d.dots === 1 ? 1.5 : 1);
}

/** True when the note continues a tie from the previous note, so it is not a new onset. */
const isTieContinuation = (d: Duration): boolean => d.tie === "stop" || d.tie === "continue";

/** Onsets in beats from the first bar's downbeat. Ties add no onset. */
export function onsetsFromDurations(measures: readonly (readonly Duration[])[]): number[] {
  const out: number[] = [];
  let t = 0;
  for (const bar of measures)
    for (const d of bar) {
      if (!isTieContinuation(d)) out.push(t);
      t += durationBeats(d);
    }
  return out;
}

const BASE_VALUE: Record<string, 2 | 4 | 8> = { h: 2, q: 4, e: 8 };

/**
 * Token grammar: `h`, `q`, `e` for half, quarter, eighth; a `.` dots it; a trailing `~` ties it to
 * the next token (which may be in the next bar). Bars are separated by `|`.
 */
function parse(id: string, difficulty: ReadRhythm["difficulty"], src: string): ReadRhythm {
  const bars = src.split("|").map((bar) => bar.trim().split(/\s+/));
  const measures: Duration[][] = [];
  const values = new Set<RhythmValue>();
  let tiedIn = false;
  for (const bar of bars) {
    const notes: Duration[] = [];
    for (const tok of bar) {
      const base = BASE_VALUE[tok.charAt(0)];
      if (base === undefined) throw new RangeError(`bad rhythm token ${tok} in ${id}`);
      const dots = tok.includes(".") ? 1 : 0;
      const tiedOut = tok.endsWith("~");
      const tie = tiedIn ? (tiedOut ? "continue" : "stop") : tiedOut ? "start" : undefined;
      notes.push({ value: base, dots, ...(tie === undefined ? {} : { tie }) });
      values.add(
        base === 2 ? "half" : base === 8 ? "eighth" : dots === 1 ? "dotted-quarter" : "quarter",
      );
      if (tiedOut || tiedIn) values.add("tie");
      tiedIn = tiedOut;
    }
    measures.push(notes);
  }
  if (tiedIn) throw new RangeError(`pattern ${id} ends on an open tie`);
  if (measures.length !== 1 && measures.length !== 2)
    throw new RangeError(`pattern ${id} must have 1 or 2 bars`);
  return {
    id,
    bars: measures.length === 1 ? 1 : 2,
    measures,
    values: [...values],
    onsetsBeats: onsetsFromDurations(measures),
    difficulty,
  };
}

/**
 * Notated patterns in 4/4, graded roughly easy to hard. Unlike the rhythmEcho table these are
 * written out so the page can show them; onsets are derived from the durations, never typed.
 * Patterns using a half note are filtered out today because `read.rhythm.basic` lists no `half`
 * value.
 */
export const READ_RHYTHMS: readonly ReadRhythm[] = [
  parse("rr01", 1, "q q q q"),
  parse("rr02", 1, "h q q"),
  parse("rr03", 1, "q q h"),
  parse("rr04", 1, "q e e q q"),
  parse("rr05", 1, "q q e e q"),
  parse("rr06", 1, "e e q q q"),
  parse("rr07", 1, "e e e e e e e e"),
  parse("rr08", 1, "q. e q q"),
  parse("rr09", 1, "q q q. e"),
  parse("rr10", 1, "q. e q. e"),
  parse("rr11", 1, "q q~ q q"), // tie inside the bar: beats 2 and 3 are one sound
  parse("rr12", 2, "q q q q~ | q q q q"), // tie across the barline
  parse("rr13", 1, "q e e e e q"),
  parse("rr14", 1, "q. e q e e"),
  parse("rr15", 1, "e q q q e"), // syncopation
  parse("rr16", 2, "q q q q | q q h"),
  parse("rr17", 2, "q e e q q | q. e q q"),
  parse("rr18", 2, "q. e q q | q q q. e"),
  parse("rr19", 2, "q q q q~ | q. e q q"),
  parse("rr20", 2, "q q e e q | e e q. e q"),
  parse("rr21", 2, "q. e q q~ | q e e q q"),
  parse("rr22", 2, "e q q q e~ | e q q. q"),
  parse("rr23", 2, "h h | q q h"),
];

const RhythmReadNodeParams = z.object({
  /** Allowed note values. Absent means all of them. */
  values: z.array(z.string()).optional(),
  /** Allowed bar counts. Absent means 1 and 2. */
  bars: z.array(z.int().min(1).max(2)).min(1).optional(),
});
const RhythmReadItemParams = z.object({ pattern: z.string() });

export const READ_TEMPO_RANGE: readonly [number, number] = [60, 80];
/** Written pitch of every note on the one-line percussion staff; the learner may play any key. */
export const READ_RHYTHM_WRITTEN_PITCH = { step: "B", alter: 0, octave: 4 } as const;

function available(node: SkillNode): ReadRhythm[] {
  const np = RhythmReadNodeParams.parse(node.params);
  return READ_RHYTHMS.filter(
    (r) =>
      (np.bars ?? [1, 2]).includes(r.bars) &&
      (np.values === undefined || r.values.every((v) => np.values?.includes(v))),
  );
}

function scoreSpec(pat: ReadRhythm): ScoreSpec {
  let n = 0;
  return {
    staves: [
      {
        clef: "percussion",
        lines: 1,
        measures: pat.measures.map((bar) =>
          bar.map((duration): ScoreNote => ({
            kind: "note",
            id: "n" + String(++n),
            pitches: [{ ...READ_RHYTHM_WRITTEN_PITCH }],
            duration: { ...duration },
          })),
        ),
      },
    ],
    key: null,
    meter: { beats: BEATS_PER_BAR, beatValue: 4 },
  };
}

/**
 * Rhythm reading: the pattern is shown on a one-line staff, the stimulus is only a 4-click count-in
 * (R17, no pattern audio), and any key counts, so the expected rhythm target has no pitch.
 */
export const rhythmRead: Generator = {
  id: "rhythmRead",
  listItems(node: SkillNode): ItemParams[] {
    return available(node).map((r) => ({ pattern: r.id }));
  },
  generate(node: SkillNode, params: ItemParams, ctx: GenerateContext): ItemInstance {
    const { pattern: patternId } = RhythmReadItemParams.parse(params);
    const pat = available(node).find((r) => r.id === patternId);
    if (pat === undefined)
      throw new RangeError(`unknown rhythm pattern ${patternId} for node ${node.id}`);
    const { rng } = ctx;
    const [lo, hi] = READ_TEMPO_RANGE;
    const tempoBpm = rng.int(Math.ceil(lo / 5), Math.floor(hi / 5)) * 5;
    const seed = rng.int(0, 0x7fffffff);
    const beatSec = 60 / tempoBpm;

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

    return {
      itemId: itemId(node.id, { pattern: pat.id }),
      nodeId: node.id,
      generator: "rhythmRead",
      params: { pattern: pat.id },
      presentation: { pattern: pat.id, tempoBpm, seed },
      stimulus: { events, tempoBpm },
      display: scoreSpec(pat),
      expected: {
        play: {
          kind: "rhythm",
          onsetsBeats: [...pat.onsetsBeats],
          tempoBpm,
          beatsPerBar: BEATS_PER_BAR,
        },
        responseWindowMs: 12000,
      },
      ...latencyField(node),
    };
  },
};
