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

/**
 * Audio recorded for one answer (T8.19): mono samples at `sampleRate`, the first at `startMs` on
 * the AudioContext clock. `truncated` is set when the take hit the length cap and the end was
 * dropped. Empty when nothing was captured.
 */
export interface MicTake {
  samples: Float32Array;
  sampleRate: number;
  startMs: number;
  truncated: boolean;
}

/** Longest take kept, in seconds. A two-hand phrase at 60 bpm is about 20 s. */
export const MAX_TAKE_SEC = 30;

/** Main thread -> worker. */
export type WorkerInbound =
  | { type: "init"; port: MessagePort; config?: PipelineConfig }
  | { type: "pause" }
  | { type: "resume" }
  /** Live register hint for the octave check and fold; `null` clears it. */
  | { type: "range"; range: MidiRange | null }
  /** Send back the audio recorded since the last `resume` (T8.19), then keep recording. */
  | { type: "take" }
  | { type: "stop" };

/** Worker -> main thread. */
export type WorkerOutbound =
  | { type: "frame"; frame: PitchFrame }
  /** `start`: pitch known, no `offsetMs`. `end`: complete note with `offsetMs`. */
  | { type: "note"; phase: "start" | "end"; note: NoteEvent }
  | { type: "take"; take: MicTake }
  | { type: "stopped" };
