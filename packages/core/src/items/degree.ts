import { z } from "zod";
import type { GeneratorId, SkillNode } from "../graph/schema.js";
import { degreeToMidi, tonicMidiForRange } from "../theory/degrees.js";
import type { MinorVariant } from "../theory/keys.js";
import { tonicChroma } from "../theory/keys.js";
import type { ExpectedResponse } from "./expected.js";
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

const DegreeNodeParams = z.object({
  mode: z.enum(["major", "minor"]),
  degrees: z.array(z.int().min(-6).max(14)).min(1),
  variants: z.array(z.enum(["natural", "harmonic", "melodic"])).optional(),
});
const DegreeItemParams = z.object({ degree: z.int() });

export const DEGREE_ID_WINDOW_MS = 8000;

/** Item universe shared by degreeSing and degreeId: one item per node degree (R14). */
function listDegreeItems(node: SkillNode): ItemParams[] {
  const p = DegreeNodeParams.parse(node.params);
  return p.degrees.map((degree) => ({ degree }));
}

function opt(v: MinorVariant | undefined): { minorVariant: MinorVariant } | undefined {
  return v === undefined ? undefined : { minorVariant: v };
}

function make(id: GeneratorId): Generator {
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

      const range = ctx.keyboardRange ?? DEFAULT_KEYBOARD_RANGE;
      // The target sounds in the register of the cadence before it, so the ear does not have to
      // follow an octave change as well as the degree. Another range falls back to its centre.
      const near = registerNearCadence(key, [degree], range, opt(variant));
      const tonicMidi =
        near?.tonicMidi ??
        tonicMidiForRange(key, range, { low: degree, high: degree }, opt(variant)).tonicMidi;
      const targetMidi = near?.midi[0] ?? degreeToMidi(key, degree, tonicMidi, opt(variant));
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

      const expected: ExpectedResponse = {
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

/**
 * Play the degree by ear (the Away tap variant too). The learner no longer sings: the answer is
 * played on the keyboard. `degreeSing` is kept as an id so earlier events and plans still resolve,
 * and behaves exactly like `degreeId` (R14: same item universe and ids).
 */
export const degreeSing: Generator = make("degreeSing");
export const degreeId: Generator = make("degreeId");
