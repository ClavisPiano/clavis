import { z } from "zod";
import { GeneratorIdSchema } from "../graph/schema.js";
import { InputSourceSchema } from "../input/types.js";
import { JsonObjectSchema } from "../json.js";
import { isValidKey } from "../theory/keys.js";
import { envelopeShape } from "./envelope.js";
import { ULID_REGEX } from "./ulid.js";

/* Learning event payloads (plan R1-R8, spec 5.2, 6.5, 10, 11). */

const ulid = z.string().regex(ULID_REGEX, "must be a ULID");

/** Spec 5.2. */
export const AttemptOutcomeSchema = z.strictObject({
  correct: z.boolean(),
  latencyMs: z.number().min(0),
  retries: z.int().min(0),
  partial: z.number().min(0).max(1).optional(),
});
export type AttemptOutcome = z.infer<typeof AttemptOutcomeSchema>;

export const AttemptErrorSchema = z.strictObject({
  /** Dotted error code, for example "degree.confusion.6-5". */
  code: z.string().min(1),
  detail: JsonObjectSchema.optional(),
});
export type AttemptError = z.infer<typeof AttemptErrorSchema>;

export const SessionKeySchema = z
  .strictObject({
    tonic: z.string(),
    mode: z.enum(["major", "minor"]),
  })
  .refine(isValidKey, { message: "unsupported key" });

export const KeyFamilySchema = z.enum(["A", "B", "C"]);
export const BlockSchema = z.enum(["orient", "ear", "read", "apply"]);
export const PlacementResultSchema = z.enum(["mastered", "fluent", "available"]);

export const SessionStartedV1 = z.strictObject({
  ...envelopeShape,
  type: z.literal("session.started"),
  v: z.literal(1),
  sessionId: ulid,
  mode: z.enum(["instrument", "away"]),
  budgetSec: z.int().positive(),
  key: SessionKeySchema,
  tzOffsetMin: z.int().min(-840).max(840),
  contentVersion: z.string().min(1),
});

export const ItemPresentedV1 = z.strictObject({
  ...envelopeShape,
  type: z.literal("item.presented"),
  v: z.literal(1),
  sessionId: ulid,
  itemId: z.string().min(1),
  nodeId: z.string().min(1),
  generator: GeneratorIdSchema,
  block: BlockSchema,
  isNew: z.boolean(),
  /** Everything needed to replay the item without regenerating it (R2). */
  presentation: JsonObjectSchema,
});

export const AttemptCompletedV1 = z.strictObject({
  ...envelopeShape,
  type: z.literal("attempt.completed"),
  v: z.literal(1),
  sessionId: ulid,
  itemId: z.string().min(1),
  nodeId: z.string().min(1),
  outcome: AttemptOutcomeSchema,
  subScores: z
    .strictObject({
      sing: z.number().min(0).max(1).optional(),
      play: z.number().min(0).max(1).optional(),
    })
    .optional(),
  inputSource: InputSourceSchema,
  errors: z.array(AttemptErrorSchema).optional(),
  performanceRef: z.string().min(1).optional(),
});

export const NodeIntroducedV1 = z.strictObject({
  ...envelopeShape,
  type: z.literal("node.introduced"),
  v: z.literal(1),
  sessionId: ulid,
  nodeId: z.string().min(1),
  keyFamily: KeyFamilySchema.optional(),
});

export const PlacementCompletedV1 = z.strictObject({
  ...envelopeShape,
  type: z.literal("placement.completed"),
  v: z.literal(1),
  placementId: ulid,
  results: z.record(z.string().min(1), PlacementResultSchema),
});

export const SessionEndedV1 = z.strictObject({
  ...envelopeShape,
  type: z.literal("session.ended"),
  v: z.literal(1),
  sessionId: ulid,
  reason: z.enum(["completed", "abandoned", "timeout"]),
});
