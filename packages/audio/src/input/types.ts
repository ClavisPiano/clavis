import type { InputSource, NoteEvent, PitchFrame, VoiceRange } from "@clavis/core";

/**
 * A source of played notes (architecture 4.1). Mic, on-screen keyboard (tap) and MIDI all
 * look the same to the session runner.
 *
 * Every timestamp (`NoteEvent.onsetMs` / `offsetMs`, `PitchFrame.atMs`) is on the AudioContext
 * clock in ms (`context.currentTime * 1000`), the same clock as `StimulusPlayer`'s `endAt * 1000`,
 * so scoring can subtract one from the other.
 *
 * Note delivery: one `NoteEvent` per note, emitted at onset. `offsetMs` is left unset, because
 * `@clavis/scoring` only uses `onsetMs` (response latency and window membership) and waiting for
 * the note to finish would delay feedback by the note's length.
 */
export interface InputAdapter {
  readonly source: InputSource;
  start(): Promise<void>;
  stop(): void;
  /** Gate the input (e.g. during stimulus playback, T1.6). While paused, events are dropped. */
  pause(): void;
  resume(): void;
  /** Returns an unsubscribe function. */
  onNote(cb: (e: NoteEvent) => void): () => void;
  /**
   * Optional. Tell a pitch-detecting input which register (MIDI numbers, inclusive) the next
   * answer is in, so it can resolve octave ambiguity; `null` clears it. Inputs that report exact
   * keys (tap, MIDI) ignore it.
   */
  setExpectedRange?(range: VoiceRange | null): void;
  /** Continuous pitch frames. Never called for tap input. */
  onFrame(cb: (f: PitchFrame) => void): () => void;
}

/** A small typed listener set shared by the adapters. */
export class Emitter<T> {
  readonly #listeners = new Set<(value: T) => void>();

  add(cb: (value: T) => void): () => void {
    this.#listeners.add(cb);
    return () => {
      this.#listeners.delete(cb);
    };
  }

  emit(value: T): void {
    for (const cb of [...this.#listeners]) cb(value);
  }
}
