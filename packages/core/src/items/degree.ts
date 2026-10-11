import { z } from "zod";
import type { GeneratorId, SkillNode } from "../graph/schema.js";
import { degreeToMidi, tonicMidiForRange } from "../theory/degrees.js";
import type { Key, MinorVariant, VoiceRange } from "../theory/keys.js";
import { tonicChroma } from "../theory/keys.js";
import type { ExpectedResponse } from "./expected.js";
import { cadenceStimulus, chooseKey, degreeLabels, keyToJson, latencyField } from "./build.js";
import { itemId } from "./ids.js";
import {
  DEFAULT_KEYBOARD_RANGE,
  type GenerateContext,
  type Generator,
  type ItemInstance,
  type ItemParams,
} from "./types.js";

const DegreeNodeParams = z.object({
  mode: z.enum(["major", "minor"]),
  degrees: z.array(z.int().min(-6).max(14)).min(1),
  variants: z.array(z.enum(["natural", "harmonic", "melodic"])).optional(),
});
const DegreeItemParams = z.object({ degree: z.int() });

export const SING_TOLERANCE_CENTS = 50;
export const DEGREE_SING_WINDOW_MS = 10000;
export const DEGREE_ID_WINDOW_MS = 8000;

/** Item universe shared by degreeSing and degreeId: one item per node degree (R14). */
function listDegreeItems(node: SkillNode): ItemParams[] {
  const p = DegreeNodeParams.parse(node.params);
  return p.degrees.map((degree) => ({ degree }));
}

function singable(range: VoiceRange, key: Key, degree: number, v?: MinorVariant): number {
  return degreeToMidi(
    key,
    degree,
    tonicMidiForRange(key, range, { low: degree, high: degree }, opt(v)).tonicMidi,
    opt(v),
  );
}

function opt(v: MinorVariant | undefined): { minorVariant: MinorVariant } | undefined {
  return v === undefined ? undefined : { minorVariant: v };
}

function make(id: GeneratorId, sung: boolean): Generator {
  return {
    id,
    listItems: listDegreeItems,
    generate(node: SkillNode, params: ItemParams, ctx: GenerateContext): ItemInstance {
      const np = DegreeNodeParams.parse(node.params);
      const { degree } = DegreeItemParams.parse(params);
      if (!np.degrees.includes(degree))
        throw new RangeError(`degree ${String(degree)} is not in node ${node.id}`);
      const { rng } = ctx;
      const key = chooseKey(np.mode, ctx.preferredKey, rng);
      const variant: MinorVariant | undefined =
        np.mode === "minor" && np.variants !== undefined && np.variants.length > 0
          ? rng.pick(np.variants)
          : undefined;
      const seed = rng.int(0, 0x7fffffff);

      const heardRange = sung ? ctx.voiceRange : (ctx.keyboardRange ?? DEFAULT_KEYBOARD_RANGE);
      const tonicMidi = tonicMidiForRange(
        key,
        heardRange,
        { low: degree, high: degree },
        opt(variant),
      ).tonicMidi;
      const targetMidi = degreeToMidi(key, degree, tonicMidi, opt(variant));
      const labels = degreeLabels(key, opt(variant));

      const cad = cadenceStimulus(key);
      const stimulus = {
        events: [
          ...cad.events,
          {
            atSec: cad.targetStartSec,
            midi: [targetMidi],
            durationSec: cad.beatSec * 2,
            velocity: 0.8,
            role: "target" as const,
          },
        ],
        tempoBpm: cad.tempoBpm,
      };

      const expected: ExpectedResponse = sung
        ? {
            sing: {
              kind: "sungPitch",
              targetMidi,
              toleranceCents: SING_TOLERANCE_CENTS,
              degreeLabels: labels,
            },
            play: {
              kind: "pitchClass",
              targetMidi: singable(
                ctx.keyboardRange ?? DEFAULT_KEYBOARD_RANGE,
                key,
                degree,
                variant,
              ),
              degreeLabels: labels,
            },
            responseWindowMs: DEGREE_SING_WINDOW_MS,
          }
        : {
            play: { kind: "pitchClass", targetMidi, degreeLabels: labels },
            responseWindowMs: DEGREE_ID_WINDOW_MS,
          };

      return {
        itemId: itemId(node.id, { degree }),
        nodeId: node.id,
        generator: id,
        params: { degree },
        presentation: {
          key: keyToJson(key),
          tonic: key.tonic,
          mode: key.mode,
          tonicMidi,
          tonicChroma: tonicChroma(key),
          degree,
          targetMidi,
          tempoBpm: cad.tempoBpm,
          seed,
          ...(variant === undefined ? {} : { minorVariant: variant }),
        },
        stimulus,
        expected,
        ...latencyField(node),
      };
    },
  };
}

/** Sing the degree, then play it (spec 7). Target in the voice range. */
export const degreeSing: Generator = make("degreeSing", true);
/** Play-only (and Away tap) variant. Same item universe and ids as degreeSing (R14). */
export const degreeId: Generator = make("degreeId", false);
