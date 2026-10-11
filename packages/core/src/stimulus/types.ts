import { z } from "zod";

export const StimulusRoleSchema = z.enum(["cadence", "target", "count-in", "reference"]);
export type StimulusRole = z.infer<typeof StimulusRoleSchema>;

export const StimulusEventSchema = z.strictObject({
  /** Seconds from stimulus start. */
  atSec: z.number().min(0),
  /** One or more MIDI notes sounded together (a chord). */
  midi: z.array(z.int().min(0).max(127)).min(1),
  durationSec: z.number().positive(),
  velocity: z.number().min(0).max(1),
  role: StimulusRoleSchema.optional(),
});
export type StimulusEvent = z.infer<typeof StimulusEventSchema>;

/** Plain data the audio layer plays. */
export const StimulusSpecSchema = z.strictObject({
  events: z.array(StimulusEventSchema),
  tempoBpm: z.number().positive().optional(),
});
export type StimulusSpec = z.infer<typeof StimulusSpecSchema>;

/** End time of the last note to finish, in seconds. Zero for an empty spec. */
export function stimulusDurationSec(spec: StimulusSpec): number {
  let end = 0;
  for (const e of spec.events) end = Math.max(end, e.atSec + e.durationSec);
  return end;
}
