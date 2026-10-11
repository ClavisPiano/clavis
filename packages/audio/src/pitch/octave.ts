import { foldMidi, hzToMidi, type MidiRange } from "./midi.js";

/**
 * Octave check for low notes (R20, T3.12).
 *
 * Why: on a phone mic a piano note in C2..B2 often has almost no energy at its fundamental (small
 * speaker-like body, high-pass in the mic path) while the 2nd harmonic is strong. MPM then reports
 * the 2nd harmonic, one octave high. The segmenter's `expectedRange` fold cannot repair this when
 * both octaves are inside the item's register (C2..E4 for bass reading).
 *
 * Heuristic. For the MPM estimate `f` and its octave neighbours `f/2` and `2f` that fall inside
 * the allowed register, measure the spectral amplitude (Hann-windowed Goertzel on the analysis
 * frame) at the first three harmonics of each candidate `c`:
 *
 *   support(c) = min(A(c), A(3c)) / max(A(c), A(2c), A(3c))
 *
 * The 1st and 3rd harmonics are the discriminator: when the true note is `f`, the energy at `f/2`
 * and at `3f/2` is only window leakage, so `f/2` is not supported. When the true note is `f/2`,
 * `f` is its strong 2nd harmonic and both `f/2` and `3f/2` hold real partials.
 *
 * Decision (thresholds in `OCTAVE_CHECK`):
 * - The lower octave wins when `support(f/2) >= LOWER_SUPPORT` (0.05, about -26 dB).
 * - Otherwise the upper octave wins when `support(f) < UPPER_UNSUPPORTED` (0.02) and
 *   `support(2f) >= UPPER_SUPPORT` (0.25). This repairs a subharmonic read. It is deliberately
 *   stricter, because a pure tone has no 3rd harmonic and must never be moved up.
 * - Otherwise `f` is kept.
 *
 * When it runs: with an expected range, on every frame; without one, only when `f` is below
 * `LOW_HZ` (130 Hz), and candidates must stay inside `[minHz, maxHz]`. Pure and shared, so the
 * worker and the Node fixture runner execute the same code.
 */

export const OCTAVE_CHECK = {
  /** Without an expected range the check only runs below this frequency. */
  LOW_HZ: 130,
  LOWER_SUPPORT: 0.05,
  UPPER_UNSUPPORTED: 0.02,
  UPPER_SUPPORT: 0.25,
} as const;

const hannCache = new Map<number, Float32Array>();

function hann(length: number): Float32Array {
  let w = hannCache.get(length);
  if (!w) {
    w = new Float32Array(length);
    for (let i = 0; i < length; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / length);
    hannCache.set(length, w);
  }
  return w;
}

/** Amplitude of the component at `hz` (a unit sine reads about 1), Hann window, any frequency. */
export function goertzelAmplitude(
  samples: ArrayLike<number>,
  sampleRate: number,
  hz: number,
): number {
  const n = samples.length;
  if (n === 0 || hz <= 0 || hz >= sampleRate / 2) return 0;
  const w = hann(n);
  const omega = (2 * Math.PI * hz) / sampleRate;
  const coeff = 2 * Math.cos(omega);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const s = (samples[i] ?? 0) * (w[i] ?? 0) + coeff * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  // The Hann window sums to n / 2, so a unit sine has a bin magnitude of n / 4.
  return (2 * Math.sqrt(Math.max(0, power))) / (n / 2);
}

/** `min(A1, A3) / max(A1, A2, A3)` for the harmonics of `hz`. Zero when there is no energy. */
export function harmonicSupport(
  samples: ArrayLike<number>,
  sampleRate: number,
  hz: number,
): number {
  const a1 = goertzelAmplitude(samples, sampleRate, hz);
  const a2 = goertzelAmplitude(samples, sampleRate, 2 * hz);
  const a3 = goertzelAmplitude(samples, sampleRate, 3 * hz);
  const peak = Math.max(a1, a2, a3);
  return peak <= 0 ? 0 : Math.min(a1, a3) / peak;
}

export interface OctaveCheckOptions {
  /** Register the answer must lie in. Candidates outside `[min - 0.5, max + 0.5]` are ignored. */
  range?: MidiRange | undefined;
  minHz?: number;
  maxHz?: number;
}

/**
 * Returns the frequency to report for an MPM estimate `hz` on `samples`: `hz`, `hz / 2` or
 * `2 * hz`. See the module comment for the heuristic.
 */
export function chooseOctave(
  samples: ArrayLike<number>,
  sampleRate: number,
  hz: number,
  options: OctaveCheckOptions = {},
): number {
  const { range } = options;
  if (range === undefined && hz >= OCTAVE_CHECK.LOW_HZ) return hz;
  const minHz = options.minHz ?? 0;
  const maxHz = options.maxHz ?? Infinity;
  const allowed = (candidate: number): boolean => {
    if (candidate < minHz || candidate > maxHz) return false;
    if (range === undefined) return true;
    const m = hzToMidi(candidate);
    return foldMidi(m, range) === m;
  };
  const lower = hz / 2;
  if (allowed(lower) && harmonicSupport(samples, sampleRate, lower) >= OCTAVE_CHECK.LOWER_SUPPORT) {
    return lower;
  }
  const upper = hz * 2;
  if (
    allowed(upper) &&
    harmonicSupport(samples, sampleRate, hz) < OCTAVE_CHECK.UPPER_UNSUPPORTED &&
    harmonicSupport(samples, sampleRate, upper) >= OCTAVE_CHECK.UPPER_SUPPORT
  ) {
    return upper;
  }
  return hz;
}
