/** Pure helpers for the /dev/audio iOS spike page. */

/** Root mean square of a sample buffer. Zero for an empty buffer. */
export function rms(buf: readonly number[] | Float32Array): number {
  if (buf.length === 0) return 0;
  let sum = 0;
  for (const v of buf) sum += v * v;
  return Math.sqrt(sum / buf.length);
}

/** Largest absolute sample value. */
export function peakAbs(buf: readonly number[] | Float32Array): number {
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  return peak;
}

/** Median of a list, or undefined when empty. Even counts average the middle pair. */
export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const hi = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? hi : ((sorted[mid - 1] ?? 0) + hi) / 2;
}

/** Linear amplitude to dBFS. Floors at -120 so silence stays finite. */
export function toDb(amplitude: number): number {
  return amplitude <= 1e-6 ? -120 : 20 * Math.log10(amplitude);
}

export interface LevelFrame {
  /** Time of the reading, in seconds on any one consistent clock. */
  readonly t: number;
  /** Linear level (RMS or peak). */
  readonly level: number;
}

/** First frame at or after `notBefore` whose level exceeds `threshold`. */
export function firstSpike(
  frames: readonly LevelFrame[],
  threshold: number,
  notBefore = -Infinity,
): LevelFrame | undefined {
  return frames.find((f) => f.t >= notBefore && f.level > threshold);
}

/** Spike threshold: a multiple of the quiet-room level, never below an absolute floor. */
export function adaptiveThreshold(baselinePeak: number, floor = 0.02, factor = 4): number {
  return Math.max(floor, baselinePeak * factor);
}

/** Gaps between consecutive timestamps (ms) larger than `maxGapMs`. */
export function findGaps(
  timesMs: readonly number[],
  maxGapMs: number,
): { atMs: number; gapMs: number }[] {
  const gaps: { atMs: number; gapMs: number }[] = [];
  for (let i = 1; i < timesMs.length; i++) {
    const gapMs = (timesMs[i] ?? 0) - (timesMs[i - 1] ?? 0);
    if (gapMs > maxGapMs) gaps.push({ atMs: timesMs[i] ?? 0, gapMs });
  }
  return gaps;
}
