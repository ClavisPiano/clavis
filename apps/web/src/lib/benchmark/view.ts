import type { BenchmarkOption, BenchmarkRecord } from "@clavis/core";

/* Display helpers for the benchmark pages (T6.5). */

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "2026-10" as "October 2026". */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-");
  const name = MONTH_NAMES[Number(m) - 1];
  return name === undefined || y === undefined ? month : `${name} ${y}`;
}

/** Milliseconds as "m:ss". */
export function clockLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60))}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * The piece the record page starts on: the one last benchmarked when it is still offered (so the
 * months compare like with like), otherwise the hardest unlocked option, otherwise the first.
 */
export function defaultBenchmarkPiece(
  options: readonly BenchmarkOption[],
  benchmarks: Readonly<Record<string, BenchmarkRecord>>,
): string | undefined {
  const last = Object.values(benchmarks).sort((a, b) => (a.month < b.month ? 1 : -1))[0];
  if (last && options.some((o) => o.piece.id === last.pieceId)) return last.pieceId;
  const unlocked = options.filter((o) => o.unlocked);
  return (unlocked.at(-1) ?? options[0])?.piece.id;
}
