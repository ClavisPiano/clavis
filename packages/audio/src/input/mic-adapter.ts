import type { NoteEvent, PitchFrame, VoiceRange } from "@clavis/core";
import type { CaptureContext, MicStartOptions, NotePhase } from "../mic/mic-source.js";
import { Emitter, type InputAdapter } from "./types.js";

/** The slice of `MicPitchSource` this adapter uses. */
export interface MicSourceLike {
  start(options: MicStartOptions): Promise<void>;
  stop(): Promise<void>;
  pause(): void;
  resume(): void;
  setExpectedRange?(range: VoiceRange | null): void;
  onNote(cb: (note: NoteEvent, phase: NotePhase) => void): () => void;
  onFrame(cb: (frame: PitchFrame) => void): () => void;
}

export interface MicInputAdapterOptions {
  source: MicSourceLike;
  /** Resolves the (unlocked) AudioContext used for capture. Called from `start()`. */
  getContext: () => CaptureContext | Promise<CaptureContext>;
  startOptions?: Omit<MicStartOptions, "context">;
}

/**
 * Microphone input. Wraps `MicPitchSource`, which reports each note twice: `start` (pitch known,
 * about 120 ms after the onset, no `offsetMs`) and `end` (with `offsetMs`).
 *
 * Choice: forward only the `start` phase, as soon as it arrives, and drop `end`. The scorer
 * (`scorePitchClass` and friends) decides correctness and latency from `onsetMs` alone, so
 * waiting for the note to finish would only delay feedback by the note's length, and a held note
 * would never score until released. Callers that need durations can use `MicPitchSource` directly.
 */
export class MicInputAdapter implements InputAdapter {
  readonly source = "mic" as const;
  readonly #notes = new Emitter<NoteEvent>();
  readonly #frames = new Emitter<PitchFrame>();
  readonly #mic: MicSourceLike;
  readonly #options: MicInputAdapterOptions;
  #unsubscribes: (() => void)[] = [];
  #paused = false;

  constructor(options: MicInputAdapterOptions) {
    this.#options = options;
    this.#mic = options.source;
  }

  async start(): Promise<void> {
    if (this.#unsubscribes.length === 0) {
      this.#unsubscribes = [
        this.#mic.onNote((note, phase) => {
          if (phase !== "start" || this.#paused) return;
          this.#notes.emit(note);
        }),
        this.#mic.onFrame((frame) => {
          if (!this.#paused) this.#frames.emit(frame);
        }),
      ];
    }
    const context = await this.#options.getContext();
    await this.#mic.start({ ...this.#options.startOptions, context });
    if (this.#paused) this.#mic.pause();
  }

  stop(): void {
    for (const off of this.#unsubscribes) off();
    this.#unsubscribes = [];
    void this.#mic.stop();
  }

  pause(): void {
    this.#paused = true;
    this.#mic.pause();
  }

  resume(): void {
    this.#paused = false;
    this.#mic.resume();
  }

  setExpectedRange(range: VoiceRange | null): void {
    this.#mic.setExpectedRange?.(range);
  }

  onNote(cb: (e: NoteEvent) => void): () => void {
    return this.#notes.add(cb);
  }

  onFrame(cb: (f: PitchFrame) => void): () => void {
    return this.#frames.add(cb);
  }
}
