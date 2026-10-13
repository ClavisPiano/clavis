import { z } from "zod";
import type { SkillNode } from "../graph/schema.js";
import type { StimulusEvent } from "../stimulus/types.js";
import { tonicChroma } from "../theory/keys.js";
import { at } from "../theory/util.js";
import type { ChoiceOption } from "./expected.js";
import { cadenceStimulus, chooseKey, keyToJson, latencyField } from "./build.js";
import { itemId } from "./ids.js";
import type { GenerateContext, Generator, ItemInstance, ItemParams } from "./types.js";

const QUALITIES = ["major", "minor", "diminished"] as const;
type Quality = (typeof QUALITIES)[number];

const ChordQualityNodeParams = z.object({
  /** The qualities offered, in button order. The first two are major and minor. */
  qualities: z.array(z.enum(QUALITIES)).min(2),
  /** Major scale degrees the chord can be built on. */
  roots: z.array(z.int().min(1).max(7)).min(1),
});
const ChordQualityItemParams = z.object({
  quality: z.enum(QUALITIES),
  root: z.int().min(1).max(7),
});

/** Time allowed for choosing, after the chord ends. */
export const CHORD_QUALITY_WINDOW_MS = 8000;

const LABEL: Readonly<Record<Quality, string>> = {
  major: "Major",
  minor: "Minor",
  diminished: "Diminished",
};
/** Semitones above the root of the third and the fifth. */
const INTERVALS: Readonly<Record<Quality, readonly [number, number]>> = {
  major: [4, 7],
  minor: [3, 7],
  diminished: [3, 6],
};
/** Semitones above the tonic of major scale degrees 1 to 7. */
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11] as const;
/** The chord's root sits in this octave (G3 to F#4), so the chord is clearly above the bass. */
const ROOT_LOW = 55;
const BASS_LOW = 36;
const lift = (chroma: number, low: number): number => low + ((((chroma - low) % 12) + 12) % 12);

/**
 * Hear a triad after the cadence and say whether it is major, minor or diminished (spec 7,
 * `chordQuality`). The triad sits on a degree of the key's major scale, in root position with the
 * root doubled in the bass. Answered with buttons (R21), so the item needs no pitch input.
 */
export const chordQuality: Generator = {
  id: "chordQuality",
  listItems(node: SkillNode): ItemParams[] {
    const p = ChordQualityNodeParams.parse(node.params);
    return p.qualities.flatMap((quality) => p.roots.map((root) => ({ quality, root })));
  },
  generate(node: SkillNode, params: ItemParams, ctx: GenerateContext): ItemInstance {
    const np = ChordQualityNodeParams.parse(node.params);
    const { quality, root } = ChordQualityItemParams.parse(params);
    if (!np.qualities.includes(quality) || !np.roots.includes(root))
      throw new RangeError(`${quality} on ${String(root)} is not in node ${node.id}`);
    const { rng } = ctx;
    const key = chooseKey("major", ctx.preferredKey, rng);
    const seed = rng.int(0, 0x7fffffff);

    const rootChroma = (tonicChroma(key) + at(MAJOR_SCALE, root - 1)) % 12;
    const rootMidi = lift(rootChroma, ROOT_LOW);
    const [third, fifth] = INTERVALS[quality];
    const chord = [lift(rootChroma, BASS_LOW), rootMidi, rootMidi + third, rootMidi + fifth];

    const cad = cadenceStimulus(key);
    const heard: StimulusEvent = {
      atSec: cad.targetStartSec,
      midi: chord,
      durationSec: cad.beatSec * 2,
      velocity: 0.8,
      role: "target",
    };
    const options: ChoiceOption[] = np.qualities.map((q) => ({ id: q, label: LABEL[q] }));

    return {
      itemId: itemId(node.id, { quality, root }),
      nodeId: node.id,
      generator: "chordQuality",
      params: { quality, root },
      presentation: {
        key: keyToJson(key),
        tonic: key.tonic,
        mode: key.mode,
        tonicChroma: tonicChroma(key),
        quality,
        root,
        chordMidi: chord,
        tempoBpm: cad.tempoBpm,
        seed,
      },
      stimulus: { events: [...cad.events, heard], tempoBpm: cad.tempoBpm },
      expected: {
        play: { kind: "choice", options, correct: quality },
        responseWindowMs: CHORD_QUALITY_WINDOW_MS,
      },
      ...latencyField(node),
    };
  },
};
