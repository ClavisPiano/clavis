import type { InputSource, NoteEvent, PitchFrame, VoiceRange } from "@clavis/core";
import { Emitter, type InputAdapter } from "./types.js";

export interface FakeScriptStep {
  /** Milliseconds after the anchor (start time, or `anchorMs`). */
  atMs: number;
  /** Merged over defaults: pitch 60, onsetMs = anchor + atMs, confidence 1. */
  note?: Partial<NoteEvent>;
  frame?: PitchFrame;
}

/** Injected time source. `schedule` returns a cancel function. */
export interface FakeClock {
  now(): number;
  schedule(delayMs: number, fn: () => void): () => void;
}

export const realClock: FakeClock = {
  now: () => performance.now(),
  schedule: (delayMs, fn) => {
    const id = setTimeout(fn, delayMs);
    return () => {
      clearTimeout(id);
    };
  },
};

export interface FakeInputAdapterOptions {
  /** What `source` reports. Default "mic". */
  source?: InputSource;
  clock?: FakeClock;
  script?: readonly FakeScriptStep[];
  /**
   * Makes this a transcribing input (T8.19): `finishTake` returns these notes, as the mic does
   * after a take. Called once per take.
   */
  takeNotes?: () => readonly NoteEvent[] | Promise<readonly NoteEvent[]>;
  /** Script times are relative to this clock reading instead of the `start()` time. */
  anchorMs?: number;
}

/**
 * Scripted input for tests and Playwright. Steps are replayed in `atMs` order (ties keep script
 * order) once `start()` is called. `emitNote` / `emitFrame` deliver immediately, whether or not the
 * adapter was started, so tests need no setup; both are dropped while paused.
 */
export class FakeInputAdapter implements InputAdapter {
  readonly source: InputSource;
  readonly #notes = new Emitter<NoteEvent>();
  readonly #frames = new Emitter<PitchFrame>();
  readonly #clock: FakeClock;
  readonly #script: readonly FakeScriptStep[];
  readonly #anchorMs: number | undefined;
  readonly #takeNotes: FakeInputAdapterOptions["takeNotes"];
  #cancels: (() => void)[] = [];
  #paused = false;
  /** The last range passed to `setExpectedRange` (null when cleared or never set). */
  expectedRange: VoiceRange | null = null;
  /** Every `setExpectedRange` argument in call order, for tests. */
  readonly expectedRangeCalls: (VoiceRange | null)[] = [];

  constructor(options: FakeInputAdapterOptions = {}) {
    this.source = options.source ?? "mic";
    this.#clock = options.clock ?? realClock;
    this.#script = options.script ?? [];
    this.#anchorMs = options.anchorMs;
    this.#takeNotes = options.takeNotes;
  }

  get transcribes(): boolean {
    return this.#takeNotes !== undefined;
  }

  async finishTake(): Promise<NoteEvent[]> {
    return [...((await this.#takeNotes?.()) ?? [])];
  }

  /** Current time on the adapter's clock, for building `onsetMs` values. */
  nowMs(): number {
    return this.#clock.now();
  }

  start(): Promise<void> {
    this.#cancelAll();
    const startMs = this.#clock.now();
    const anchor = this.#anchorMs ?? startMs;
    const ordered = this.#script
      .map((step, index) => ({ step, index }))
      .sort((a, b) => a.step.atMs - b.step.atMs || a.index - b.index);
    for (const { step } of ordered) {
      const delay = Math.max(0, anchor + step.atMs - startMs);
      this.#cancels.push(
        this.#clock.schedule(delay, () => {
          if (step.note) this.emitNote({ onsetMs: anchor + step.atMs, ...step.note });
          if (step.frame) this.emitFrame(step.frame);
        }),
      );
    }
    return Promise.resolve();
  }

  stop(): void {
    this.#cancelAll();
  }

  pause(): void {
    this.#paused = true;
  }

  resume(): void {
    this.#paused = false;
  }

  setExpectedRange(range: VoiceRange | null): void {
    this.expectedRange = range;
    this.expectedRangeCalls.push(range);
  }

  onNote(cb: (e: NoteEvent) => void): () => void {
    return this.#notes.add(cb);
  }

  onFrame(cb: (f: PitchFrame) => void): () => void {
    return this.#frames.add(cb);
  }

  /** Deliver a note now. Returns it, or undefined if dropped while paused. */
  emitNote(note: Partial<NoteEvent> = {}): NoteEvent | undefined {
    if (this.#paused) return undefined;
    const full: NoteEvent = {
      pitch: 60,
      onsetMs: this.#clock.now(),
      confidence: 1,
      source: this.source,
      ...note,
    };
    this.#notes.emit(full);
    return full;
  }

  emitFrame(frame: Partial<PitchFrame> = {}): PitchFrame | undefined {
    if (this.#paused) return undefined;
    const full: PitchFrame = { hz: 261.63, confidence: 1, atMs: this.#clock.now(), ...frame };
    this.#frames.emit(full);
    return full;
  }

  #cancelAll(): void {
    for (const cancel of this.#cancels) cancel();
    this.#cancels = [];
  }
}

/** Manual clock for tests: time moves only through `advance`. */
export class ManualClock implements FakeClock {
  #now: number;
  #seq = 0;
  readonly #timers = new Map<number, { at: number; fn: () => void }>();

  constructor(startMs = 0) {
    this.#now = startMs;
  }

  now(): number {
    return this.#now;
  }

  schedule(delayMs: number, fn: () => void): () => void {
    const id = this.#seq++;
    this.#timers.set(id, { at: this.#now + delayMs, fn });
    return () => {
      this.#timers.delete(id);
    };
  }

  /** Move time forward, firing due timers in time order (then creation order). */
  advance(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of this.#timers) {
        if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) next = entry;
      }
      if (!next) break;
      this.#timers.delete(next[0]);
      this.#now = Math.max(this.#now, next[1].at);
      next[1].fn();
    }
    this.#now = target;
  }
}
