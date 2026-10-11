import type { AttemptError } from "@clavis/core";

export type ErrorDetail = NonNullable<AttemptError["detail"]>;

export function err(code: string, detail?: ErrorDetail): AttemptError {
  return detail === undefined ? { code } : { code, detail };
}

export function pc(midi: number): number {
  return ((Math.round(midi) % 12) + 12) % 12;
}

export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

/** Fold a cents difference into [-600, 600). */
export function foldCents(cents: number): number {
  return ((((cents + 600) % 1200) + 1200) % 1200) - 600;
}

export function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return Number.NaN;
  const mid = n >> 1;
  return n % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

export function degreeLabel(
  labels: readonly string[] | undefined,
  midi: number,
): string | undefined {
  return labels?.[pc(midi)];
}

/** Degree confusion error, or a plain wrong-pitch error when no labels are available. */
export function degreeConfusion(
  labels: readonly string[] | undefined,
  expectedMidi: number,
  playedMidi: number,
  extra?: ErrorDetail,
): AttemptError {
  const e = degreeLabel(labels, expectedMidi);
  const p = degreeLabel(labels, playedMidi);
  if (e !== undefined && p !== undefined) {
    return err(`degree.confusion.${e}-${p}`, { expected: e, played: p, ...extra });
  }
  return err("pitch.wrong", { expected: pc(expectedMidi), played: pc(playedMidi), ...extra });
}

/** Notes in the response window, sorted by onset. */
export function inWindow<T extends { onsetMs: number }>(
  notes: readonly T[],
  stimulusEndMs: number,
  responseWindowMs: number,
): T[] {
  return notes
    .filter((n) => n.onsetMs >= stimulusEndMs && n.onsetMs - stimulusEndMs <= responseWindowMs)
    .sort((a, b) => a.onsetMs - b.onsetMs);
}

/** Unwrap an indexed access that is known to be in range. */
export function req<T>(value: T | undefined): T {
  if (value === undefined) throw new RangeError("index out of range");
  return value;
}
