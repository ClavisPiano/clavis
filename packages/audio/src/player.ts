import type { StimulusSpec } from "@clavis/core";
import type { Instrument } from "./instrument.js";

/** One note ready to hand to an Instrument. Times are AudioContext seconds. */
export interface NoteStart {
  midi: number;
  time: number;
  duration: number;
  /** 0..1 */
  velocity: number;
}

/**
 * Flatten a spec into individual notes at `startAt + event.atSec`. Chords become simultaneous
 * notes. Output is ordered by time (stable, so chord voicing order is kept).
 */
export function scheduleNotes(spec: StimulusSpec, startAt: number): NoteStart[] {
  const notes: NoteStart[] = [];
  for (const e of spec.events) {
    const velocity = Math.min(1, Math.max(0, e.velocity));
    for (const midi of e.midi) {
      notes.push({ midi, time: startAt + e.atSec, duration: e.durationSec, velocity });
    }
  }
  return notes.sort((a, b) => a.time - b.time);
}

/**
 * End of the last note to finish, in AudioContext seconds. Same maths as core's
 * `stimulusDurationSec`, repeated here because audio may only import types from core.
 */
export function endTime(spec: StimulusSpec, startAt: number): number {
  let end = 0;
  for (const e of spec.events) end = Math.max(end, e.atSec + e.durationSec);
  return startAt + end;
}

export interface Clock {
  readonly currentTime: number;
}

export interface PlayOptions {
  /** Absolute AudioContext time to begin. Overrides `leadInSec`. */
  startAt?: number;
  /** Seconds after "now" to begin when `startAt` is not given. Default 0.1. */
  leadInSec?: number;
}

export interface PlayResult {
  startAt: number;
  endAt: number;
}

export const DEFAULT_LEAD_IN_SEC = 0.1;

export class StimulusPlayer {
  readonly #clock: Clock;
  readonly #instrument: Instrument;

  constructor(clock: Clock, instrument: Instrument) {
    this.#clock = clock;
    this.#instrument = instrument;
  }

  /** Load the instrument. Await this before the first play(). */
  load(): Promise<void> {
    return this.#instrument.load();
  }

  /** Schedule every note of `spec`. Returns the AudioContext time window it occupies. */
  play(spec: StimulusSpec, opts: PlayOptions = {}): PlayResult {
    const startAt =
      opts.startAt ?? this.#clock.currentTime + (opts.leadInSec ?? DEFAULT_LEAD_IN_SEC);
    for (const n of scheduleNotes(spec, startAt)) this.#instrument.start(n);
    return { startAt, endAt: endTime(spec, startAt) };
  }

  /** Silence everything, including notes scheduled but not yet begun. */
  stop(): void {
    this.#instrument.stopAll();
  }
}
