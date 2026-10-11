import { z } from "zod";

/**
 * What an item expects the learner to produce. Written by item generators
 * (core/items) and consumed by `@clavis/scoring`, which may only import core
 * types. Everything scoring needs is therefore precomputed here as data, for
 * example degree labels, so scoring never calls theory functions.
 *
 * R12: an attempt can have a sung part and a played part. At the instrument
 * both must be right for the attempt to be correct; in Away mode the single
 * part (`sing`, or `play` via taps) decides.
 */

const midi = z.int().min(0).max(127);

/**
 * Degree label for each pitch class (index 0 = C ... 11 = B) in the
 * presentation key, e.g. "1", "b3", "#4". Used to name confusions such as
 * "degree.confusion.6-5" without theory at scoring time.
 */
export const DegreeLabelsSchema = z.array(z.string().min(1)).length(12);
export type DegreeLabels = z.infer<typeof DegreeLabelsSchema>;

export const PitchClassTargetSchema = z.strictObject({
  kind: z.literal("pitchClass"),
  targetMidi: midi,
  degreeLabels: DegreeLabelsSchema,
});

export const ExactPitchTargetSchema = z.strictObject({
  kind: z.literal("exactPitch"),
  targetMidi: midi,
});

export const SequenceTargetSchema = z.strictObject({
  kind: z.literal("sequence"),
  midi: z.array(midi).min(1),
  /** True when only pitch classes must match (ear cells); false for reading. */
  octaveAgnostic: z.boolean(),
  degreeLabels: DegreeLabelsSchema,
});

export const RhythmTargetSchema = z.strictObject({
  kind: z.literal("rhythm"),
  /** Onsets in beats from the first note (first is 0). */
  onsetsBeats: z.array(z.number().min(0)).min(1),
  tempoBpm: z.number().positive(),
  beatsPerBar: z.int().positive(),
  /** Pitch used for the stimulus; responses are scored on timing only. */
  pitch: midi.optional(),
});

export const PlayTargetSchema = z.discriminatedUnion("kind", [
  PitchClassTargetSchema,
  ExactPitchTargetSchema,
  SequenceTargetSchema,
  RhythmTargetSchema,
]);
export type PlayTarget = z.infer<typeof PlayTargetSchema>;

export const SungPitchTargetSchema = z.strictObject({
  kind: z.literal("sungPitch"),
  /** Octave-agnostic: the sung pitch class must be within tolerance of this note's. */
  targetMidi: midi,
  toleranceCents: z.number().positive(),
  /** Names confusions for sing-only (Away) attempts, where there is no play target. */
  degreeLabels: DegreeLabelsSchema.optional(),
});

export const SungSequenceTargetSchema = z.strictObject({
  kind: z.literal("sungSequence"),
  midi: z.array(midi).min(1),
  toleranceCents: z.number().positive(),
  degreeLabels: DegreeLabelsSchema.optional(),
});

export const SingTargetSchema = z.discriminatedUnion("kind", [
  SungPitchTargetSchema,
  SungSequenceTargetSchema,
]);
export type SingTarget = z.infer<typeof SingTargetSchema>;

export const ExpectedResponseSchema = z
  .strictObject({
    sing: SingTargetSchema.optional(),
    play: PlayTargetSchema.optional(),
    /** How long after stimulus end a response is accepted before timing out. */
    responseWindowMs: z.int().positive(),
  })
  .refine((e) => e.sing !== undefined || e.play !== undefined, {
    message: "expected response needs a sing or play target",
  });
export type ExpectedResponse = z.infer<typeof ExpectedResponseSchema>;
