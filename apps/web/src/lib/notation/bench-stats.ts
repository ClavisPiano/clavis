/** Nearest-rank percentile of a list of numbers (p in 0..100). NaN for an empty list. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1] ?? Number.NaN;
}

export function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
