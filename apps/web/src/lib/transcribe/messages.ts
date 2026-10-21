import type { TranscribedNote } from "@clavis/audio";
import { z } from "zod";

export interface WorkerRequest {
  id: number;
  samples: Float32Array;
  sampleRate: number;
  /** Where the model's `model.json` is served. */
  modelUrl: string;
}

const NoteSchema = z.object({
  startSec: z.number(),
  durationSec: z.number(),
  midi: z.number(),
  amplitude: z.number(),
}) satisfies z.ZodType<TranscribedNote>;

/** What the worker posts back. Parsed on arrival: the worker is our own code, but it is a boundary. */
export const WorkerReplySchema = z.discriminatedUnion("ok", [
  z.object({
    id: z.number(),
    ok: z.literal(true),
    notes: z.array(NoteSchema),
    backend: z.string(),
  }),
  z.object({ id: z.number(), ok: z.literal(false), error: z.string() }),
]);

export type WorkerReply = z.infer<typeof WorkerReplySchema>;
