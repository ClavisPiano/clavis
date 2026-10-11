import { z } from "zod";

/** Where a note came from (spec 11, plus "tap" for the Away mode tap input, R3). */
export const InputSourceSchema = z.enum(["midi", "mic", "tap"]);
export type InputSource = z.infer<typeof InputSourceSchema>;

export const NoteEventSchema = z.strictObject({
  pitch: z.int().min(0).max(127),
  onsetMs: z.number(),
  offsetMs: z.number().optional(),
  velocity: z.int().min(0).max(127).optional(),
  confidence: z.number().min(0).max(1),
  source: InputSourceSchema,
});
export type NoteEvent = z.infer<typeof NoteEventSchema>;

export const PitchFrameSchema = z.strictObject({
  /** Null when no pitch was detected in the frame. */
  hz: z.number().nullable(),
  cents: z.number().optional(),
  confidence: z.number().min(0).max(1),
  atMs: z.number(),
});
export type PitchFrame = z.infer<typeof PitchFrameSchema>;
