import type { NoteEvent, PitchFrame } from "@clavis/core";
import { Emitter, type InputAdapter } from "./types.js";
import { eventTimeToContextMs, type OutputTimestampLike } from "./time.js";

/** The slice of `AudioContext` the tap adapter needs. */
export interface TapContextLike {
  readonly currentTime: number;
  getOutputTimestamp?(): OutputTimestampLike;
}

export interface TapInputAdapterOptions {
  /** Looked up on every event, so a context created after the adapter still works. */
  getContext: () => TapContextLike | undefined;
  /** `performance.now()`. Injectable for tests. */
  now?: () => number;
}

/**
 * On-screen keyboard input (Away mode, spec 6.5). The keyboard component calls `press` and
 * `release` with the DOM `event.timeStamp`; this converts it to the AudioContext clock.
 * Emits one note per press, at onset, with `confidence: 1` and no velocity.
 */
export class TapInputAdapter implements InputAdapter {
  readonly source = "tap" as const;
  readonly #notes = new Emitter<NoteEvent>();
  readonly #frames = new Emitter<PitchFrame>();
  readonly #getContext: () => TapContextLike | undefined;
  readonly #now: () => number;
  readonly #held = new Set<number>();
  #running = false;
  #paused = false;

  constructor(options: TapInputAdapterOptions) {
    this.#getContext = options.getContext;
    this.#now = options.now ?? (() => performance.now());
  }

  start(): Promise<void> {
    this.#running = true;
    return Promise.resolve();
  }

  stop(): void {
    this.#running = false;
    this.#held.clear();
  }

  pause(): void {
    this.#paused = true;
  }

  resume(): void {
    this.#paused = false;
  }

  onNote(cb: (e: NoteEvent) => void): () => void {
    return this.#notes.add(cb);
  }

  /** Tap input has no pitch frames; the subscription is accepted and never fires. */
  onFrame(cb: (f: PitchFrame) => void): () => void {
    return this.#frames.add(cb);
  }

  /** Key down. Returns the emitted event, or undefined when stopped or paused. */
  press(midi: number, eventTimeStamp: number): NoteEvent | undefined {
    if (!this.#running || this.#paused) return undefined;
    this.#held.add(midi);
    const note: NoteEvent = {
      pitch: midi,
      onsetMs: this.#toContextMs(eventTimeStamp),
      confidence: 1,
      source: "tap",
    };
    this.#notes.emit(note);
    return note;
  }

  /** Key up. Emits nothing (notes are delivered at onset); returns the release time in ms. */
  release(midi: number, eventTimeStamp: number): number | undefined {
    if (!this.#held.delete(midi)) return undefined;
    return this.#toContextMs(eventTimeStamp);
  }

  #toContextMs(eventTimeStamp: number): number {
    const ctx = this.#getContext();
    return eventTimeToContextMs(eventTimeStamp, {
      outputTimestamp: ctx?.getOutputTimestamp?.(),
      contextNowMs: (ctx?.currentTime ?? 0) * 1000,
      performanceNowMs: this.#now(),
    });
  }
}
