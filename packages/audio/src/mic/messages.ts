import type { NoteEvent, PitchFrame } from "@clavis/core";
import type { MidiRange } from "../pitch/midi.js";
import type { NoteSegmenterOptions } from "../pitch/segmenter.js";
import type { PitchTrackerOptions } from "../pitch/tracker.js";

/** Name the capture processor registers under. */
export const CAPTURE_PROCESSOR_NAME = "clavis-pitch-capture";

/** Samples per chunk posted by the worklet (16 render quanta of 128). */
export const DEFAULT_CAPTURE_CHUNK = 2048;

/**
 * Worklet -> worker, over the MessageChannel port. `samples` is transferred, not copied.
 * `startFrame` is the worklet's `currentFrame` at the first sample, so the chunk start time on the
 * AudioContext clock is `startFrame / sampleRate`. That is the time the sample reached the
 * worklet, which is later than the time it was captured by the input latency (calibrated in T1.7).
 */
export interface CaptureChunk {
  type: "chunk";
  samples: Float32Array;
  startFrame: number;
  sampleRate: number;
}

/** Main thread -> worklet (over `node.port`). */
export interface WorkletInbound {
  type: "port";
  port: MessagePort;
}

export interface PipelineConfig {
  tracker?: Omit<PitchTrackerOptions, "sampleRate">;
  segmenter?: NoteSegmenterOptions;
}

/** Main thread -> worker. */
export type WorkerInbound =
  | { type: "init"; port: MessagePort; config?: PipelineConfig }
  | { type: "pause" }
  | { type: "resume" }
  /** Live register hint for the octave check and fold; `null` clears it. */
  | { type: "range"; range: MidiRange | null }
  | { type: "stop" };

/** Worker -> main thread. */
export type WorkerOutbound =
  | { type: "frame"; frame: PitchFrame }
  /** `start`: pitch known, no `offsetMs`. `end`: complete note with `offsetMs`. */
  | { type: "note"; phase: "start" | "end"; note: NoteEvent }
  | { type: "stopped" };
