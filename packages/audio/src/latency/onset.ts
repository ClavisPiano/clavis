/**
 * Energy onset detector for the loopback path. The click has no stable pitch, so the pitch
 * pipeline is no use; this works on per-render-quantum peak levels.
 *
 * An onset is the first level above `max(minLevel, noiseFloor * ratio)` after a refractory gap.
 * The noise floor is a slow average of the levels seen while below threshold.
 */

export interface OnsetDetectorOptions {
  /** Absolute floor for the threshold (linear amplitude). Default 0.02. */
  minLevel?: number;
  /** Threshold as a multiple of the noise floor. Default 6. */
  ratio?: number;
  /** Ignore further onsets this long after one, ms. Default 200. */
  refractoryMs?: number;
}

export class OnsetDetector {
  readonly #minLevel: number;
  readonly #ratio: number;
  readonly #refractoryMs: number;
  #floor = 0;
  #seeded = false;
  #lastOnsetMs = -Infinity;

  constructor(options: OnsetDetectorOptions = {}) {
    this.#minLevel = options.minLevel ?? 0.02;
    this.#ratio = options.ratio ?? 6;
    this.#refractoryMs = options.refractoryMs ?? 200;
  }

  get threshold(): number {
    return Math.max(this.#minLevel, this.#floor * this.#ratio);
  }

  /** Feed one level reading. Returns the onset time (`timeMs`) when this reading starts one. */
  push(timeMs: number, level: number): number | undefined {
    if (!this.#seeded) {
      this.#floor = level;
      this.#seeded = true;
    }
    if (level > this.threshold) {
      if (timeMs - this.#lastOnsetMs >= this.#refractoryMs) {
        this.#lastOnsetMs = timeMs;
        return timeMs;
      }
      return undefined;
    }
    this.#floor += (level - this.#floor) * 0.02;
    return undefined;
  }
}

/** Run a detector over a whole series. `times` and `levels` are parallel arrays. */
export function detectOnsets(
  times: readonly number[],
  levels: readonly number[],
  options?: OnsetDetectorOptions,
): number[] {
  const det = new OnsetDetector(options);
  const out: number[] = [];
  levels.forEach((level, i) => {
    const onset = det.push(times[i] ?? 0, level);
    if (onset !== undefined) out.push(onset);
  });
  return out;
}
