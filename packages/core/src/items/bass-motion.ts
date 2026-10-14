import { z } from "zod";
import type { SkillNode } from "../graph/schema.js";
import type { StimulusEvent } from "../stimulus/types.js";
import { MAJOR_ROMANS, MAJOR_ROMAN_ROOTS, progression } from "../theory/cadence.js";
import { tonicChroma, type VoiceRange } from "../theory/keys.js";
import { at } from "../theory/util.js";
import { cadenceStimulus, chooseKey, degreeLabels, keyToJson, latencyField } from "./build.js";
import { itemId } from "./ids.js";
import {
  DEFAULT_KEYBOARD_RANGE,
  type GenerateContext,
  type Generator,
  type ItemInstance,
  type ItemParams,
} from "./types.js";

const BassMotionNodeParams = z.object({
  mode: z.literal("major"),
  chords: z
    .array(z.string().refine((r) => MAJOR_ROMANS.includes(r), "unknown major Roman numeral"))
    .min(2),
});
const BassMotionItemParams = z.object({ prog: z.array(z.string()).length(4) });

/** Chords in every progression: the home chord, then three moves. */
export const BASS_MOTION_LENGTH = 4;
/** Time allowed for playing four roots after the progression ends. */
export const BASS_MOTION_WINDOW_MS = 12000;

/**
 * Item universe: every progression of four chords drawn from the node's chords that starts on I
 * (the cadence has just returned home) and never repeats a chord twice running. For the four
 * chords I, IV, V and vi that is 3 x 3 x 3 = 27 progressions, in a stable depth-first order.
 */
export function enumerateBassMotions(chords: readonly string[]): string[][] {
  const out: string[][] = [];
  const rec = (prog: string[]): void => {
    if (prog.length === BASS_MOTION_LENGTH) {
      out.push(prog);
      return;
    }
    for (const c of chords) {
      if (c !== at(prog, prog.length - 1)) rec([...prog, c]);
    }
  };
  if (chords.includes("I")) rec(["I"]);
  return out;
}

/** The lowest note of each chord's root, placed in the bottom octave of `range`. */
function rootsInRange(
  tonicChromaValue: number,
  prog: readonly string[],
  range: VoiceRange,
): number[] {
  return prog.map((roman) => {
    const degree = MAJOR_ROMAN_ROOTS[roman];
    if (degree === undefined) throw new RangeError(`unknown Roman numeral: ${roman}`);
    // Major scale offsets of degrees 1..7 above the tonic.
    const offset = at([0, 2, 4, 5, 7, 9, 11], degree - 1);
    const chroma = (tonicChromaValue + offset) % 12;
    return range.low + ((((chroma - range.low) % 12) + 12) % 12);
  });
}

/**
 * Hear a progression after the cadence and play its bass roots in order (spec 7, `bassMotion`).
 * The chords are I, IV, V and vi; the answer is a pitch-class sequence, so the octave does not
 * matter. Scored by the existing sequence scorer, with partial credit per root.
 */
export const bassMotion: Generator = {
  id: "bassMotion",
  listItems(node: SkillNode): ItemParams[] {
    const p = BassMotionNodeParams.parse(node.params);
    return enumerateBassMotions(p.chords).map((prog) => ({ prog }));
  },
  generate(node: SkillNode, params: ItemParams, ctx: GenerateContext): ItemInstance {
    const np = BassMotionNodeParams.parse(node.params);
    const { prog } = BassMotionItemParams.parse(params);
    if (prog.some((c) => !np.chords.includes(c)))
      throw new RangeError(`progression ${prog.join("-")} uses a chord not in node ${node.id}`);
    const { rng } = ctx;
    const key = chooseKey(np.mode, ctx.preferredKey, rng);
    const seed = rng.int(0, 0x7fffffff);

    const cad = cadenceStimulus(key);
    const chords = progression(key, prog);
    const heard: StimulusEvent[] = chords.map((c, i) => ({
      atSec: cad.targetStartSec + i * cad.beatSec,
      midi: [c.bass, ...c.upper],
      durationSec: cad.beatSec,
      velocity: 0.8,
      role: "target" as const,
    }));
    const played = rootsInRange(
      tonicChroma(key),
      prog,
      ctx.keyboardRange ?? DEFAULT_KEYBOARD_RANGE,
    );

    return {
      itemId: itemId(node.id, { prog }),
      nodeId: node.id,
      generator: "bassMotion",
      params: { prog },
      presentation: {
        key: keyToJson(key),
        tonic: key.tonic,
        mode: key.mode,
        tonicChroma: tonicChroma(key),
        prog,
        bassMidi: chords.map((c) => c.bass),
        targetMidi: played,
        tempoBpm: cad.tempoBpm,
        seed,
      },
      stimulus: { events: [...cad.events, ...heard], tempoBpm: cad.tempoBpm },
      expected: {
        play: {
          kind: "sequence",
          midi: played,
          octaveAgnostic: true,
          degreeLabels: degreeLabels(key),
        },
        responseWindowMs: BASS_MOTION_WINDOW_MS,
      },
      ...latencyField(node),
    };
  },
};
