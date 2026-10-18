import { learnerDay } from "../learning/day.js";
import { listPieces } from "../pieces/list.js";
import { isUserPieceId, type Piece } from "../pieces/schema.js";
import type { BenchmarkRecord, LearnerState } from "../state/types.js";

/*
 * Monthly benchmark (T6.5, R28, spec 14). Pure helpers over the library and the learner state: which
 * pieces to offer, which month a take belongs to, and how the replay page lists them.
 */

/** At most this many pieces are offered. */
export const MAX_BENCHMARK_OPTIONS = 4;
/** With fewer unlocked pieces than this, the list is padded with the easiest locked ones. */
export const MIN_BENCHMARK_OPTIONS = 3;

export interface BenchmarkOption {
  piece: Piece;
  /** False for a padding piece the learner has not unlocked yet. */
  unlocked: boolean;
}

/**
 * The pieces a benchmark can be recorded on: library pieces only (imports are skipped), the up to
 * four unlocked ones with the highest difficulty, padded with the lowest-difficulty locked pieces
 * when fewer than three are unlocked. Ties in difficulty go to the later library piece for the
 * unlocked pick and the earlier one for padding. Returned easiest first (library order).
 */
export function benchmarkOptions(
  library: readonly Piece[],
  learner: Pick<LearnerState, "nodes" | "pieces">,
): BenchmarkOption[] {
  const listed = listPieces(
    library.filter((p) => !isUserPieceId(p.id)),
    learner,
  ).map((s, index) => ({ piece: s.piece, unlocked: s.unlocked, index }));
  const unlocked = listed
    .filter((s) => s.unlocked)
    .sort((a, b) => b.piece.difficulty - a.piece.difficulty || b.index - a.index)
    .slice(0, MAX_BENCHMARK_OPTIONS);
  const padding = listed
    .filter((s) => !s.unlocked)
    .sort((a, b) => a.piece.difficulty - b.piece.difficulty || a.index - b.index)
    .slice(0, Math.max(0, MIN_BENCHMARK_OPTIONS - unlocked.length));
  return [...unlocked, ...padding]
    .sort((a, b) => a.index - b.index)
    .map(({ piece, unlocked: u }) => ({ piece, unlocked: u }));
}

/**
 * The learner-local month ("YYYY-MM") of a time, from the learner day (R6), so a take just after
 * midnight on the first, before the 04:00 rollover, still counts for the month before.
 */
export function benchmarkMonth(atMs: number, tzOffsetMin: number): string {
  return learnerDay(atMs, tzOffsetMin).slice(0, 7);
}

/** True while `month` has no benchmark: Home and /progress then prompt for one. */
export function needsBenchmark(learner: Pick<LearnerState, "benchmarks">, month: string): boolean {
  return !Object.hasOwn(learner.benchmarks, month);
}

const newestFirst = (a: BenchmarkRecord, b: BenchmarkRecord): number =>
  a.month < b.month ? 1 : a.month > b.month ? -1 : 0;

export interface PieceBenchmarks {
  pieceId: string;
  /** Newest month first. */
  benchmarks: BenchmarkRecord[];
}

/**
 * Benchmarks grouped by piece. Pieces are ordered by their newest benchmark (most recent first), and
 * each piece's benchmarks are newest month first.
 */
export function benchmarksByPiece(learner: Pick<LearnerState, "benchmarks">): PieceBenchmarks[] {
  const groups = new Map<string, BenchmarkRecord[]>();
  for (const b of Object.values(learner.benchmarks).sort(newestFirst)) {
    const list = groups.get(b.pieceId);
    if (list) list.push(b);
    else groups.set(b.pieceId, [b]);
  }
  return [...groups].map(([pieceId, benchmarks]) => ({ pieceId, benchmarks }));
}

/**
 * The default pair for side-by-side replay: the newest take and the oldest earlier one. `earlier`
 * is undefined when the piece has a single benchmark.
 */
export function defaultComparison(benchmarks: readonly BenchmarkRecord[]): {
  latest: BenchmarkRecord | undefined;
  earlier: BenchmarkRecord | undefined;
} {
  const sorted = [...benchmarks].sort(newestFirst);
  return { latest: sorted[0], earlier: sorted.length > 1 ? sorted.at(-1) : undefined };
}

/** The file extension for a benchmark blob of this content type. */
export function benchmarkExtension(contentType: string): string {
  if (contentType.startsWith("audio/mp4")) return "m4a";
  if (contentType.startsWith("audio/ogg")) return "ogg";
  return "webm";
}

/** The blob key for a benchmark: `benchmark-<ulid>.<ext>`. */
export function benchmarkBlobKey(benchmarkId: string, contentType: string): string {
  return `benchmark-${benchmarkId}.${benchmarkExtension(contentType)}`;
}
