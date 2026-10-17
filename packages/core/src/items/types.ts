import type { GeneratorId, SkillNode } from "../graph/schema.js";
import type { JsonObject } from "../json.js";
import type { SessionMode } from "../learning/rating.js";
import type { Rng } from "../random.js";
import type { ScoreSpec } from "../score/schema.js";
import type { StimulusSpec } from "../stimulus/types.js";
import type { Key, VoiceRange } from "../theory/keys.js";
import type { ExpectedResponse } from "./expected.js";

/** Canonical item params: the identity of an item within a node (R1). Excludes key/tonic. */
export type ItemParams = JsonObject;

/** Default range for played items (C3..C6). */
export const DEFAULT_KEYBOARD_RANGE: VoiceRange = { low: 48, high: 84 };

export interface GenerateContext {
  rng: Rng;
  /** Key of the day. Used when its mode matches the item's mode (spec 6.3). */
  preferredKey?: Key;
  /** Range for played items. Defaults to C3..C6. */
  keyboardRange?: VoiceRange;
  mode: SessionMode;
}

export interface ItemInstance {
  /** `nodeId|canonical params` (R1). Same for every tonic and generator of the node (R14). */
  itemId: string;
  nodeId: string;
  /** The generator that produced this instance. */
  generator: GeneratorId;
  /** Canonical item params (the part of the identity after the node id). */
  params: ItemParams;
  /** Everything needed to replay the stimulus (R2): tonic, mode, tonicMidi, notes, tempo, seed. */
  presentation: JsonObject;
  stimulus: StimulusSpec;
  expected: ExpectedResponse;
  targetLatencyMs?: number;
  /**
   * What to draw for visual items (R17). Derived from the item on demand, never written to
   * events; `presentation` still carries the replay params (R2).
   */
  display?: ScoreSpec;
  /**
   * A score to draw beside the audio while the skill is new (the audio is still the question).
   * Unlike `display` it does not make the item a reading item: the stimulus plays as usual.
   */
  staff?: ScoreSpec;
  /**
   * The answer as a score, shown only after the learner has answered (play it by ear). Unlike
   * `display` it is not part of the question, so the item is still an ear item.
   */
  reveal?: ScoreSpec;
  /** Playable range for the on-screen keyboard or MIDI input, when it differs from the default. */
  inputRange?: VoiceRange;
  /**
   * Audiate before playing (R29): once the stimulus has ended the learner is asked to sing or hum
   * it, out loud or in their head, and answers when ready. Ungraded and untimed: nothing listens
   * to the voice, and the answer window opens at Ready.
   */
  cue?: true;
}

export interface Generator {
  id: GeneratorId;
  /** The full item universe of a node, deterministic and in a stable order. */
  listItems(node: SkillNode): ItemParams[];
  generate(node: SkillNode, params: ItemParams, ctx: GenerateContext): ItemInstance;
}
