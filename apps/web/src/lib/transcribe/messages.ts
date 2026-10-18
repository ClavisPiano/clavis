import type { TranscribedNote } from "@clavis/audio";

export interface WorkerRequest {
  id: number;
  samples: Float32Array;
  sampleRate: number;
  /** Where the model's `model.json` is served. */
  modelUrl: string;
}

export type WorkerReply =
  | { id: number; ok: true; notes: TranscribedNote[]; backend: string }
  | { id: number; ok: false; error: string };
