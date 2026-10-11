import type { PitchFrame } from "@clavis/core";
import { DEFAULT_ANALYSE_OPTIONS, acRms, analyseFrame, type AnalyseOptions } from "./analyse.js";
import { centsFromNearest, type MidiRange } from "./midi.js";
import { chooseOctave } from "./octave.js";

export interface PitchTrackerOptions extends AnalyseOptions {
  sampleRate: number;
  /** Analysis window in samples. Default 2048. */
  windowSize?: number;
  /** Samples between frames. Default 512. */
  hop?: number;
  /** A chunk starting more than this far from where the previous one ended restarts tracking. */
  gapToleranceMs?: number;
  /**
   * Register of the expected answer. Enables the octave check (`chooseOctave`) on every frame;
   * without it the check runs only for estimates below 130 Hz.
   */
  expectedRange?: MidiRange;
  /** Turn the octave check off entirely. Default false. */
  disableOctaveCheck?: boolean;
}

/** Energy of the newest hop of a window, with its own (finer) time span. */
export interface EnergySample {
  rms: number;
  startMs: number;
  endMs: number;
}

export interface TrackerOutput {
  /** `atMs` is the centre of the analysis window. */
  frame: PitchFrame;
  /** RMS of the newest `hop` samples, used for onset detection. */
  energy: EnergySample;
}

/**
 * Streaming pitch tracker. Feed contiguous chunks of any size together with the time of the
 * chunk's first sample (AudioContext clock, ms). Frames land on a fixed grid of `hop` samples
 * measured from the first chunk, so the output does not depend on how the stream was chunked.
 *
 * The buffer starts pre-filled with silence, so the first frame is emitted after one hop and a
 * note that begins right at the start of the stream is not missed.
 */
export class PitchTracker {
  readonly sampleRate: number;
  readonly windowSize: number;
  readonly hop: number;
  readonly #analyse: AnalyseOptions;
  readonly #gapToleranceMs: number;
  readonly #octaveCheck: boolean;
  #range: MidiRange | undefined;
  #buf = new Float32Array(0);
  /** Absolute sample index (0 = first real sample) of #buf[0]. */
  #bufStart = 0;
  /** Absolute index of the next sample to arrive. */
  #received = 0;
  #originMs = 0;
  #anchored = false;

  constructor(options: PitchTrackerOptions) {
    this.sampleRate = options.sampleRate;
    this.windowSize = options.windowSize ?? 2048;
    this.hop = options.hop ?? 512;
    if (this.hop <= 0 || this.hop > this.windowSize) {
      throw new RangeError("hop must be in 1..windowSize");
    }
    this.#gapToleranceMs = options.gapToleranceMs ?? 5;
    this.#octaveCheck = options.disableOctaveCheck !== true;
    this.#range = options.expectedRange;
    this.#analyse = {
      ...(options.minClarity !== undefined && { minClarity: options.minClarity }),
      ...(options.minHz !== undefined && { minHz: options.minHz }),
      ...(options.maxHz !== undefined && { maxHz: options.maxHz }),
      ...(options.minRms !== undefined && { minRms: options.minRms }),
    };
    this.reset();
  }

  /** Change the register used by the octave check. `undefined` removes it. */
  setExpectedRange(range: MidiRange | undefined): void {
    this.#range = range;
  }

  /** Forget all buffered audio. The next chunk re-anchors the clock. */
  reset(): void {
    const lead = this.windowSize - this.hop;
    this.#buf = new Float32Array(lead);
    this.#bufStart = -lead;
    this.#received = 0;
    this.#anchored = false;
  }

  #timeOf(absIndex: number): number {
    return this.#originMs + (absIndex * 1000) / this.sampleRate;
  }

  push(samples: Float32Array, startMs: number): TrackerOutput[] {
    if (!this.#anchored) {
      this.#anchored = true;
      this.#originMs = startMs;
    } else if (Math.abs(startMs - this.#timeOf(this.#received)) > this.#gapToleranceMs) {
      this.reset();
      this.#originMs = startMs;
    }
    const merged = new Float32Array(this.#buf.length + samples.length);
    merged.set(this.#buf);
    merged.set(samples, this.#buf.length);
    this.#received += samples.length;

    const out: TrackerOutput[] = [];
    let pos = 0;
    while (merged.length - pos >= this.windowSize) {
      const window = merged.subarray(pos, pos + this.windowSize);
      const winStartAbs = this.#bufStart + pos;
      const winEndAbs = winStartAbs + this.windowSize;
      const r = analyseFrame(window, this.sampleRate, this.#analyse);
      const hz =
        r.hz !== null && this.#octaveCheck
          ? chooseOctave(window, this.sampleRate, r.hz, {
              range: this.#range,
              minHz: this.#analyse.minHz ?? DEFAULT_ANALYSE_OPTIONS.minHz,
              maxHz: this.#analyse.maxHz ?? DEFAULT_ANALYSE_OPTIONS.maxHz,
            })
          : r.hz;
      const frame: PitchFrame = {
        hz,
        confidence: r.clarity,
        atMs: this.#timeOf(winStartAbs + this.windowSize / 2),
      };
      if (hz !== null) frame.cents = centsFromNearest(hz);
      out.push({
        frame,
        energy: {
          rms: acRms(window, this.windowSize - this.hop, this.windowSize),
          startMs: this.#timeOf(winEndAbs - this.hop),
          endMs: this.#timeOf(winEndAbs),
        },
      });
      pos += this.hop;
    }
    this.#bufStart += pos;
    this.#buf = merged.slice(pos);
    return out;
  }
}
