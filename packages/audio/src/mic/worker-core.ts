import { PitchPipeline } from "../pitch/pipeline.js";
import type { CaptureChunk, PipelineConfig, WorkerOutbound } from "./messages.js";

/**
 * The logic of the pitch worker without any worker globals, so it can run in Node tests.
 * `pitch.worker.ts` wires it to `self` and to the MessagePort from the worklet.
 */
export class PitchWorkerCore {
  readonly #post: (message: WorkerOutbound) => void;
  #config: PipelineConfig = {};
  #pipeline: PitchPipeline | undefined;
  #sampleRate = 0;
  #paused = false;

  constructor(post: (message: WorkerOutbound) => void) {
    this.#post = post;
  }

  configure(config: PipelineConfig | undefined): void {
    this.#config = config ?? {};
    this.#pipeline = undefined;
  }

  pause(): void {
    this.#paused = true;
    // Drop the note in progress and buffered audio: nothing heard while paused may count.
    this.#pipeline?.reset();
  }

  resume(): void {
    this.#paused = false;
    this.#pipeline?.reset();
  }

  get paused(): boolean {
    return this.#paused;
  }

  handleChunk(chunk: CaptureChunk): void {
    if (this.#paused) return;
    if (!this.#pipeline || chunk.sampleRate !== this.#sampleRate) {
      this.#sampleRate = chunk.sampleRate;
      this.#pipeline = new PitchPipeline(chunk.sampleRate, this.#config);
    }
    const startMs = (chunk.startFrame * 1000) / chunk.sampleRate;
    const { frames, events } = this.#pipeline.push(chunk.samples, startMs);
    for (const frame of frames) this.#post({ type: "frame", frame });
    for (const e of events) this.#post({ type: "note", phase: e.type, note: e.note });
  }

  /** End any note in progress, then report that the worker is done. */
  stop(): void {
    if (!this.#paused && this.#pipeline) {
      for (const e of this.#pipeline.flush()) {
        this.#post({ type: "note", phase: e.type, note: e.note });
      }
    }
    this.#post({ type: "stopped" });
  }
}
