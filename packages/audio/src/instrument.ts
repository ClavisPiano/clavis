/** Anything that can play pitched notes at precise audio-clock times. */
export interface Instrument {
  /** Fetch and decode whatever the instrument needs. Safe to call more than once. */
  load(): Promise<void>;
  /** Schedule a note. `time` and `duration` are in AudioContext seconds. `velocity` is 0..1. */
  start(note: InstrumentNote): void;
  /** Stop everything now, or at `time` (AudioContext seconds). Also cancels notes not yet begun. */
  stopAll(time?: number): void;
}

export interface InstrumentNote {
  midi: number;
  time: number;
  duration: number;
  velocity: number;
}

/** Test double that records every call. */
export class FakeInstrument implements Instrument {
  readonly started: InstrumentNote[] = [];
  readonly stops: (number | undefined)[] = [];
  loadCalls = 0;

  load(): Promise<void> {
    this.loadCalls++;
    return Promise.resolve();
  }

  start(note: InstrumentNote): void {
    this.started.push({ ...note });
  }

  stopAll(time?: number): void {
    this.stops.push(time);
  }
}
