import { z } from "zod";
import {
  MAX_BLOB_BYTES,
  baseContentType,
  isAllowedBlobType,
  isValidBlobName,
} from "../blobs/index.js";
import { GeneratorIdSchema } from "../graph/schema.js";
import { InputSourceSchema } from "../input/types.js";
import { JsonObjectSchema } from "../json.js";
import {
  IMPORTED_PIECE_SOURCE,
  PhraseSchema,
  USER_PIECE_ID_REGEX,
  UserPieceSchema,
} from "../pieces/schema.js";
import { ScoreSpecSchema } from "../score/schema.js";
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

/** v2 (T2.15) adds `practice`: an extra session that records attempts but leaves FSRS cards alone. */
export const SessionStartedV2 = z.strictObject({
  ...SessionStartedV1.shape,
  v: z.literal(2),
  practice: z.boolean().optional(),
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

/**
 * A whole-piece run finished (MP, TP.4): the learner played every phrase of a piece one after
 * another. Each phrase is also an ordinary `item.presented` and `attempt.completed` pair, so this
 * event only records the run itself. The piece counts as played through when every phrase was
 * correct (`correctPhrases === phrases`).
 */
export const PieceCompletedV1 = z
  .strictObject({
    ...envelopeShape,
    type: z.literal("piece.completed"),
    v: z.literal(1),
    sessionId: ulid,
    pieceId: z.string().regex(/^piece\.[a-z0-9-]+$/),
    phrases: z.int().min(1),
    correctPhrases: z.int().min(0),
  })
  .refine((e) => e.correctPhrases <= e.phrases, {
    message: "correctPhrases cannot exceed phrases",
    path: ["correctPhrases"],
  });

/** What a piece import came from. */
export const ImportSourceSchema = z.enum(["musicxml", "mxl"]);

/**
 * A learner imported a score as a personal piece (T7.4, spec 15). The event is self-contained: it
 * holds the converted score, its phrases and difficulty, so replay never needs the file again
 * (R2). `partIndex` and `staff` record which part of the file was read. The payload must make a
 * valid user piece (full measures, one line, a key and a meter), so a pickup bar is rejected here
 * and the importer reports it before anything is written.
 */
export const ContentImportedV1 = z
  .strictObject({
    ...envelopeShape,
    type: z.literal("content.imported"),
    v: z.literal(1),
    pieceId: z.string().regex(USER_PIECE_ID_REGEX, "must be a user piece id"),
    title: z.string().min(1).max(120),
    source: ImportSourceSchema,
    score: ScoreSpecSchema,
    phrases: z.array(PhraseSchema).min(1),
    difficulty: z.int().min(1).max(10),
    partIndex: z.int().min(0),
    staff: z.int().min(1),
  })
  .superRefine((e, ctx) => {
    const piece = UserPieceSchema.safeParse(importedPiece(e));
    if (piece.success) return;
    for (const issue of piece.error.issues) {
      ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
    }
  });
export type ContentImported = z.infer<typeof ContentImportedV1>;

/** The piece an import event describes. Source text is fixed, the learner's file is not provenance. */
export function importedPiece(
  e: Pick<ContentImported, "pieceId" | "title" | "score" | "phrases" | "difficulty">,
): z.input<typeof UserPieceSchema> {
  return {
    id: e.pieceId,
    title: e.title,
    source: IMPORTED_PIECE_SOURCE,
    score: e.score,
    phrases: e.phrases,
    requiredNodeIds: [],
    difficulty: e.difficulty,
  };
}

export const SessionEndedV1 = z.strictObject({
  ...envelopeShape,
  type: z.literal("session.ended"),
  v: z.literal(1),
  sessionId: ulid,
  reason: z.enum(["completed", "abandoned", "timeout"]),
});

/** The longest benchmark take (R28): three minutes. */
export const MAX_BENCHMARK_MS = 180_000;
/** A calendar month, "YYYY-MM". */
export const MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;
/** `benchmark-<ulid>.<ext>`: the ULID is the benchmark id. */
export const BENCHMARK_BLOB_KEY_REGEX =
  /^benchmark-([0-7][0-9A-HJKMNP-TV-Z]{25})\.([a-z0-9]{1,8})$/;

/**
 * A monthly benchmark take was recorded (T6.5, R28): the learner played a whole library piece from
 * its score and the audio was stored as the blob `blobKey`. Not graded. `month` is the learner-local
 * month of the recording. One benchmark per month: the latest event for a month by `(at, id)`
 * replaces earlier ones.
 */
export const BenchmarkRecordedV1 = z
  .strictObject({
    ...envelopeShape,
    type: z.literal("benchmark.recorded"),
    v: z.literal(1),
    benchmarkId: ulid,
    pieceId: z
      .string()
      .regex(/^piece\.[a-z0-9-]+$/)
      .refine((id) => !USER_PIECE_ID_REGEX.test(id), "must be a library piece"),
    month: z.string().regex(MONTH_REGEX, "must be YYYY-MM"),
    blobKey: z.string().regex(BENCHMARK_BLOB_KEY_REGEX).refine(isValidBlobName),
    contentType: z
      .string()
      .refine(
        (t) => isAllowedBlobType(t) && t === baseContentType(t),
        "must be an accepted audio type without parameters",
      ),
    durationMs: z.int().min(1).max(MAX_BENCHMARK_MS),
    sizeBytes: z.int().min(1).max(MAX_BLOB_BYTES),
  })
  .refine((e) => BENCHMARK_BLOB_KEY_REGEX.exec(e.blobKey)?.[1] === e.benchmarkId, {
    message: "blobKey must name the benchmark id",
    path: ["blobKey"],
  });
export type BenchmarkRecorded = z.infer<typeof BenchmarkRecordedV1>;
