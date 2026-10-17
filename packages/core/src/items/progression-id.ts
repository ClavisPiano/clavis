import { z } from "zod";
import type { SkillNode } from "../graph/schema.js";
import type { StimulusEvent } from "../stimulus/types.js";
import { isRomanInMode, progression } from "../theory/cadence.js";
import { tonicChroma, type Key } from "../theory/keys.js";
import type { ChoiceOption } from "./expected.js";
import { cadenceStimulus, chooseKey, keyToJson, latencyField } from "./build.js";
import { itemId } from "./ids.js";
import type { GenerateContext, Generator, ItemInstance, ItemParams } from "./types.js";

/** Time allowed for choosing, after the last chord ends. */
export const PROGRESSION_ID_WINDOW_MS = 10000;
/** Chords that set the key before a cadence pair: I then ii, both moving away from the pair. */
export const CADENCE_LEAD_IN = ["I", "ii"] as const;
/** The last chord is held this many beats, so the ending is clear. */
const FINAL_BEATS = 2;
const HEARD_VELOCITY = 0.8;

const Mode = z.enum(["major", "minor"]);
const Romans = z.array(z.string().min(1)).min(2);

const NodeParams = z
  .object({
    mode: Mode,
    /** Whole progressions to tell apart. Heard after the key-setting cadence. */
    progressions: z.array(Romans).min(2).optional(),
    /** Two-chord endings by name, such as `perfect: ["V", "I"]`. Heard after a short lead-in. */
    cadences: z.record(z.string().min(1), Romans.length(2)).optional(),
  })
  .superRefine((p, ctx) => {
    if ((p.progressions === undefined) === (p.cadences === undefined)) {
      ctx.addIssue({ code: "custom", message: "give exactly one of progressions and cadences" });
    }
    if (p.cadences !== undefined && p.mode !== "major") {
      ctx.addIssue({ code: "custom", message: "cadences are heard in a major key" });
    }
    const all = [...(p.progressions ?? []), ...Object.values(p.cadences ?? {})].flat();
    for (const roman of all) {
      if (!isRomanInMode(p.mode, roman)) {
        ctx.addIssue({ code: "custom", message: `unknown ${p.mode} Roman numeral: ${roman}` });
      }
    }
  });
type NodeParamsT = z.infer<typeof NodeParams>;

const ItemParamsSchema = z.union([
  z.object({ prog: Romans }),
  z.object({ cadence: z.string().min(1) }),
]);

/** Button text for a progression: "I-V-vi-IV". */
export const progressionLabel = (romans: readonly string[]): string => romans.join("-");
/** Button text for a cadence: "perfect" becomes "Perfect". */
export const cadenceLabel = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);

/** What the learner can pick, in node order, and the chords each option plays. */
interface Option {
  choice: ChoiceOption;
  params: ItemParams;
  romans: readonly string[];
}

function optionsOf(p: NodeParamsT): Option[] {
  if (p.progressions !== undefined) {
    return p.progressions.map((prog) => {
      const label = progressionLabel(prog);
      return { choice: { id: label, label }, params: { prog }, romans: prog };
    });
  }
  return Object.entries(p.cadences ?? {}).map(([name, romans]) => ({
    choice: { id: name, label: cadenceLabel(name) },
    params: { cadence: name },
    romans,
  }));
}

/**
 * Hear a chord progression, or a two-chord cadence, and name it (spec 7, `progressionId`). A
 * progression follows the key-setting cadence (I-IV-V-I, or i-iv-V-i in minor). A cadence follows
 * a short I-ii lead-in instead, so the pair is the ending of a phrase. The chords are voiced with
 * smooth voice leading (`theory.progression`), in a random tonic of the node's mode. Answered with
 * buttons (R21), in both modes. The item is the progression or cadence, never the key (R1).
 */
export const progressionId: Generator = {
  id: "progressionId",
  listItems(node: SkillNode): ItemParams[] {
    return optionsOf(NodeParams.parse(node.params)).map((o) => o.params);
  },
  generate(node: SkillNode, params: ItemParams, ctx: GenerateContext): ItemInstance {
    const np = NodeParams.parse(node.params);
    const parsed = ItemParamsSchema.parse(params);
    const options = optionsOf(np);
    const picked = options.find((o) => itemId(node.id, o.params) === itemId(node.id, parsed));
    if (picked === undefined)
      throw new RangeError(`${itemId(node.id, parsed)} is not an item of node ${node.id}`);
    const { rng } = ctx;
    const key: Key = chooseKey(np.mode, ctx.preferredKey, rng);
    const seed = rng.int(0, 0x7fffffff);

    const isCadence = np.cadences !== undefined;
    const lead: readonly string[] = isCadence ? CADENCE_LEAD_IN : [];
    // A cadence is voiced together with its lead-in so the whole phrase moves smoothly.
    const voiced = progression(key, [...lead, ...picked.romans]);
    const context = isCadence ? undefined : cadenceStimulus(key);
    const tempoBpm = context?.tempoBpm ?? 90;
    const beatSec = 60 / tempoBpm;

    const leadEvents: StimulusEvent[] = voiced.slice(0, lead.length).map((c, i) => ({
      atSec: i * beatSec,
      midi: [c.bass, ...c.upper],
      durationSec: beatSec,
      velocity: 0.7,
      role: "cadence" as const,
    }));
    const startSec = context?.targetStartSec ?? (lead.length + 0.6) * beatSec;
    const heardChords = voiced.slice(lead.length);
    const heard: StimulusEvent[] = heardChords.map((c, i) => ({
      atSec: startSec + i * beatSec,
      midi: [c.bass, ...c.upper],
      durationSec: (i === heardChords.length - 1 ? FINAL_BEATS : 1) * beatSec,
      velocity: HEARD_VELOCITY,
      role: "target" as const,
    }));

    return {
      itemId: itemId(node.id, picked.params),
      nodeId: node.id,
      generator: "progressionId",
      params: picked.params,
      presentation: {
        key: keyToJson(key),
        tonic: key.tonic,
        mode: key.mode,
        tonicChroma: tonicChroma(key),
        option: picked.choice.id,
        romans: [...picked.romans],
        leadInMidi: voiced.slice(0, lead.length).map((c) => [c.bass, ...c.upper]),
        chordMidi: heardChords.map((c) => [c.bass, ...c.upper]),
        tempoBpm,
        seed,
      },
      stimulus: { events: [...(context?.events ?? leadEvents), ...heard], tempoBpm },
      expected: {
        play: {
          kind: "choice",
          options: options.map((o) => o.choice),
          correct: picked.choice.id,
        },
        responseWindowMs: PROGRESSION_ID_WINDOW_MS,
      },
      ...latencyField(node),
    };
  },
};
