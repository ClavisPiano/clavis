import type { MidiRange } from "../pitch/midi.js";
import { PitchPipeline } from "../pitch/pipeline.js";
import {
  MAX_TAKE_SEC,
  type CaptureChunk,
  type PipelineConfig,
  type MicTake,
  type WorkerOutbound,
} from "./messages.js";

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
  /** Live override of the configured range. `undefined`: none was set, use the config. */
  #range: MidiRange | null | undefined;
  /** Raw audio since the last resume, for transcription after the take (T8.19). */
  #chunks: Float32Array[] = [];
  #takeStartMs: number | undefined;
  #takeFrames = 0;
  #takeRate = 0;
  #truncated = false;

  constructor(post: (message: WorkerOutbound) => void) {
    this.#post = post;
  }

  configure(config: PipelineConfig | undefined): void {
    this.#config = config ?? {};
    this.#pipeline = undefined;
  }

  /** Set (or with `null` clear) the expected register. Applies to the running pipeline at once. */
  setExpectedRange(range: MidiRange | null): void {
    this.#range = range;
    this.#pipeline?.setExpectedRange(range ?? undefined);
  }

  /** The audio recorded since the last resume, which stays recorded until the next one. */
  takeSnapshot(): MicTake {
    const samples = new Float32Array(this.#takeFrames);
    let at = 0;
    for (const chunk of this.#chunks) {
      samples.set(chunk, at);
      at += chunk.length;
    }
    return {
      samples,
      sampleRate: this.#takeRate,
      startMs: this.#takeStartMs ?? 0,
      truncated: this.#truncated,
    };
  }

  #clearTake(): void {
    this.#chunks = [];
    this.#takeStartMs = undefined;
    this.#takeFrames = 0;
    this.#truncated = false;
  }

  #record(chunk: CaptureChunk, startMs: number): void {
    if (this.#takeStartMs === undefined) {
      this.#takeStartMs = startMs;
      this.#takeRate = chunk.sampleRate;
    }
    const room = Math.floor(MAX_TAKE_SEC * chunk.sampleRate) - this.#takeFrames;
    if (room <= 0) {
      this.#truncated = true;
      return;
    }
    const kept = chunk.samples.length <= room ? chunk.samples : chunk.samples.subarray(0, room);
    if (kept.length < chunk.samples.length) this.#truncated = true;
    // The chunk's buffer is not reused by the worklet, but copy so a later transfer cannot detach it.
    this.#chunks.push(kept.slice());
    this.#takeFrames += kept.length;
  }

  pause(): void {
    this.#paused = true;
    this.#clearTake();
    // Drop the note in progress and buffered audio: nothing heard while paused may count.
    this.#pipeline?.reset();
  }

  resume(): void {
    this.#paused = false;
    this.#clearTake();
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
      if (this.#range !== undefined) this.#pipeline.setExpectedRange(this.#range ?? undefined);
    }
    const startMs = (chunk.startFrame * 1000) / chunk.sampleRate;
    this.#record(chunk, startMs);
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
