import type { NoteEvent, PitchFrame } from "@clavis/core";
import type { MidiRange } from "./midi.js";
import { NoteSegmenter, type NoteSegmenterOptions, type SegmenterEvent } from "./segmenter.js";
import { PitchTracker, type PitchTrackerOptions } from "./tracker.js";

export interface PipelineOptions {
  tracker?: Omit<PitchTrackerOptions, "sampleRate">;
  segmenter?: NoteSegmenterOptions;
  /** AudioContext time (ms) of the first sample. Default 0. */
  startMs?: number;
  /** Size of the chunks fed to the tracker. Default 4096. */
  chunkSize?: number;
}

export interface PipelineResult {
  frames: PitchFrame[];
  /** Completed notes, each with `offsetMs`. */
  notes: NoteEvent[];
}

/** Streaming tracker + segmenter pair. This is what the worker runs. */
export class PitchPipeline {
  readonly tracker: PitchTracker;
  readonly segmenter: NoteSegmenter;

  constructor(sampleRate: number, options: Pick<PipelineOptions, "tracker" | "segmenter"> = {}) {
    const range = options.segmenter?.expectedRange;
    this.tracker = new PitchTracker({
      ...(range && { expectedRange: range }),
      ...options.tracker,
      sampleRate,
    });
    this.segmenter = new NoteSegmenter(options.segmenter);
  }

  push(samples: Float32Array, startMs: number): { frames: PitchFrame[]; events: SegmenterEvent[] } {
    const frames: PitchFrame[] = [];
    const events: SegmenterEvent[] = [];
    for (const { frame, energy } of this.tracker.push(samples, startMs)) {
      frames.push(frame);
      events.push(...this.segmenter.push(frame, energy));
    }
    return { frames, events };
  }

  /** Set the register hint for both the octave check and the segmenter's fold. */
  setExpectedRange(range: MidiRange | undefined): void {
    this.tracker.setExpectedRange(range);
    this.segmenter.setExpectedRange(range);
  }

  /** Discard buffered audio and any note in progress. The noise floor estimate is kept. */
  reset(): void {
    this.tracker.reset();
    this.segmenter.reset();
  }

  flush(): SegmenterEvent[] {
    return this.segmenter.flush();
  }
}

/**
 * Run the whole pipeline over a mono PCM buffer. Used by tests and by the Node fixture runner, and
 * shares every line of DSP with the worker.
 */
export function runPipelineOnPcm(
  samples: Float32Array,
  sampleRate: number,
  options: PipelineOptions = {},
): PipelineResult {
  const pipeline = new PitchPipeline(sampleRate, options);
  const chunk = options.chunkSize ?? 4096;
  const startMs = options.startMs ?? 0;
  const frames: PitchFrame[] = [];
  const notes: NoteEvent[] = [];
  const take = (events: SegmenterEvent[]): void => {
    for (const e of events) if (e.type === "end") notes.push(e.note);
  };
  for (let i = 0; i < samples.length; i += chunk) {
    const part = samples.subarray(i, Math.min(samples.length, i + chunk));
    const r = pipeline.push(part, startMs + (i * 1000) / sampleRate);
    frames.push(...r.frames);
    take(r.events);
  }
  take(pipeline.flush());
  return { frames, notes };
}
