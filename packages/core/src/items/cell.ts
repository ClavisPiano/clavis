import { z } from "zod";
import { at } from "../theory/util.js";
import type { SkillNode } from "../graph/schema.js";
import { degreeToMidi, tonicMidiForRange } from "../theory/degrees.js";
import { tonicChroma, type Key, type VoiceRange } from "../theory/keys.js";
import {
  cadenceStimulus,
  chooseKey,
  degreeLabels,
  keyToJson,
  latencyField,
  registerNearCadence,
} from "./build.js";
import { itemId } from "./ids.js";
import {
  DEFAULT_KEYBOARD_RANGE,
  type GenerateContext,
  type Generator,
  type ItemInstance,
  type ItemParams,
} from "./types.js";

const CellNodeParams = z.object({
  mode: z.literal("major"),
  minNotes: z.int().min(2),
  maxNotes: z.int().max(6),
});
const CellItemParams = z.object({ cell: z.array(z.int()).min(2) });

export const CELL_WINDOW_MS = 15000;
const CELL_STARTS = [1, 3, 5] as const;
const CELL_DEGREE_MIN = -3;
const CELL_DEGREE_MAX = 10;
/** Largest melodic move between neighbours, in scale steps (4 = a fifth). */
const MAX_MOVE = 4;
/** Cells of 3+ notes span at most this many steps; 2-note cells may span MAX_MOVE. */
const MAX_SPAN_LONG = 3;

/**
 * Item universe for melodic cells, built by rule and fully deterministic:
 *
 * - 2 to 4 notes (clamped to the node's min/max), all diatonic scale degrees in -3..10.
 * - Starts on degree 1, 3 or 5.
 * - Each move is a step or a skip, at most a fifth (1..4 scale steps), up or down. No repeated
 *   neighbours.
 * - At most one skip (move larger than a step) per cell.
 * - Cells of 3+ notes span at most 3 scale steps (a fourth) and never return straight to the
 *   previous note (no A-B-A). 2-note cells may span up to a fifth.
 *
 * Order is depth-first by start, then by move size; this is stable across runs.
 * Register note: the tonic can only move by octaves, so a cell is guaranteed to fit only
 * when the playable range spans at least 19 semitones (an octave plus the widest cell).
 */
export function enumerateCells(minNotes = 2, maxNotes = 4): number[][] {
  const out: number[][] = [];
  const rec = (cell: number[], skips: number): void => {
    if (cell.length >= Math.max(2, minNotes)) out.push(cell);
    if (cell.length >= maxNotes) return;
    const last = at(cell, cell.length - 1);
    for (let m = -MAX_MOVE; m <= MAX_MOVE; m++) {
      if (m === 0) continue;
      const n = last + m;
      if (n < CELL_DEGREE_MIN || n > CELL_DEGREE_MAX) continue;
      const s = skips + (Math.abs(m) > 1 ? 1 : 0);
      if (s > 1) continue;
      const next = [...cell, n];
      const span = Math.max(...next) - Math.min(...next);
      if (next.length >= 3 && (span > MAX_SPAN_LONG || n === cell[cell.length - 2])) continue;
      rec(next, s);
    }
  };
  for (const s of CELL_STARTS) rec([s], 0);
  return out;
}

function fitRegister(
  key: Key,
  range: VoiceRange,
  cell: number[],
): { tonicMidi: number; midi: number[] } {
  const { tonicMidi } = tonicMidiForRange(key, range, {
    low: Math.min(...cell),
    high: Math.max(...cell),
  });
  return { tonicMidi, midi: cell.map((d) => degreeToMidi(key, d, tonicMidi)) };
}

export const cellEcho: Generator = {
  id: "cellEcho",
  listItems(node: SkillNode): ItemParams[] {
    const p = CellNodeParams.parse(node.params);
    return enumerateCells(p.minNotes, p.maxNotes).map((cell) => ({ cell }));
  },
  generate(node: SkillNode, params: ItemParams, ctx: GenerateContext): ItemInstance {
    const np = CellNodeParams.parse(node.params);
    const { cell } = CellItemParams.parse(params);
    if (cell.length < np.minNotes || cell.length > np.maxNotes)
      throw new RangeError(`cell length ${String(cell.length)} outside node limits`);
    if (cell.some((d) => d < CELL_DEGREE_MIN || d > CELL_DEGREE_MAX))
      throw new RangeError("cell degree out of range");
    const { rng } = ctx;
    const key = chooseKey(np.mode, ctx.preferredKey, rng);
    const seed = rng.int(0, 0x7fffffff);

    const range = ctx.keyboardRange ?? DEFAULT_KEYBOARD_RANGE;
    // Near the cadence's last chord when the cell fits, so it is heard against the chord it follows.
    const near = registerNearCadence(key, cell, range, undefined, true);
    const played = near
      ? { tonicMidi: near.tonicMidi, midi: near.midi }
      : fitRegister(key, range, cell);

    const cad = cadenceStimulus(key);
    const stimulus = {
      events: [
        ...cad.events,
        ...played.midi.map((m, i) => ({
          atSec: cad.targetStartSec + i * cad.beatSec,
          midi: [m],
          durationSec: cad.beatSec * 0.9,
          velocity: 0.8,
          role: "target" as const,
        })),
      ],
      tempoBpm: cad.tempoBpm,
    };
    const labels = degreeLabels(key);

    return {
      itemId: itemId(node.id, { cell }),
      nodeId: node.id,
      generator: "cellEcho",
      params: { cell },
      presentation: {
        key: keyToJson(key),
        tonic: key.tonic,
        mode: key.mode,
        tonicMidi: played.tonicMidi,
        tonicChroma: tonicChroma(key),
        cell,
        targetMidi: played.midi,
        tempoBpm: cad.tempoBpm,
        seed,
      },
      stimulus,
      expected: {
        play: {
          kind: "sequence",
          midi: played.midi,
          octaveAgnostic: true,
          degreeLabels: labels,
        },
        responseWindowMs: CELL_WINDOW_MS,
      },
      ...latencyField(node),
    };
  },
};
