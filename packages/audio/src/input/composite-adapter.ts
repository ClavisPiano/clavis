import type { NoteEvent, PitchFrame, VoiceRange } from "@clavis/core";
import type { InputAdapter } from "./types.js";

/**
 * Two inputs that answer the same question: the main one (mic, MIDI) and a second one (the
 * on-screen keyboard). Notes and frames from either reach the listeners, and gating, starting and
 * stopping apply to both. `source` is the main input's; every note keeps the source it came with,
 * so a tapped note is still marked as tapped.
 */
export class CompositeInputAdapter implements InputAdapter {
  readonly #main: InputAdapter;
  readonly #extra: InputAdapter;

  constructor(main: InputAdapter, extra: InputAdapter) {
    this.#main = main;
    this.#extra = extra;
  }

  get source(): InputAdapter["source"] {
    return this.#main.source;
  }

  async start(): Promise<void> {
    await Promise.all([this.#main.start(), this.#extra.start()]);
  }

  stop(): void {
    this.#main.stop();
    this.#extra.stop();
  }

  pause(): void {
    this.#main.pause();
    this.#extra.pause();
  }

  resume(): void {
    this.#main.resume();
    this.#extra.resume();
  }

  /** Only a pitch-detecting main input needs the register; the keys are exact. */
  setExpectedRange(range: VoiceRange | null): void {
    this.#main.setExpectedRange?.(range);
  }

  onNote(cb: (e: NoteEvent) => void): () => void {
    const offs = [this.#main.onNote(cb), this.#extra.onNote(cb)];
    return () => {
      for (const off of offs) off();
    };
  }

  onFrame(cb: (f: PitchFrame) => void): () => void {
    const offs = [this.#main.onFrame(cb), this.#extra.onFrame(cb)];
    return () => {
      for (const off of offs) off();
    };
  }
}
