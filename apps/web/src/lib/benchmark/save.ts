import {
  BenchmarkRecordedV1,
  benchmarkBlobKey,
  benchmarkMonth,
  type BenchmarkRecord,
  type BenchmarkRecorded,
  type LearnerState,
} from "@clavis/core";
import type { BlobMeta, PutBlobInput } from "@clavis/store";
import type { Take } from "./recorder";

/*
 * Saving a benchmark take (T6.5, R28): the audio goes into the blob store, pinned, for the upload
 * queue to send; then `benchmark.recorded` is logged. Recording again in the same month replaces the
 * take: the superseded blob is deleted here and, when signed in, on the server (best effort).
 */

export interface SaveBenchmarkDeps {
  blobs: {
    put(input: PutBlobInput): Promise<unknown>;
    delete(key: string): Promise<void>;
  };
  append: (events: BenchmarkRecorded[]) => Promise<LearnerState>;
  /** Undefined when signed out: the superseded blob never reached the server, or cannot be reached. */
  deleteRemote: ((key: string) => Promise<void>) | undefined;
  deviceId: string;
  newId: () => string;
  now: () => number;
  tzOffsetMin: number;
}

export interface SaveBenchmarkResult {
  event: BenchmarkRecorded;
  /** The month's earlier benchmark, now replaced. */
  replaced: BenchmarkRecord | undefined;
}

export async function saveBenchmark(
  deps: SaveBenchmarkDeps,
  state: Pick<LearnerState, "benchmarks">,
  pieceId: string,
  take: Take,
): Promise<SaveBenchmarkResult> {
  const at = deps.now();
  const month = benchmarkMonth(at, deps.tzOffsetMin);
  const benchmarkId = deps.newId();
  const blobKey = benchmarkBlobKey(benchmarkId, take.contentType);
  const event = BenchmarkRecordedV1.parse({
    id: deps.newId(),
    deviceId: deps.deviceId,
    at,
    type: "benchmark.recorded",
    v: 1,
    benchmarkId,
    pieceId,
    month,
    blobKey,
    contentType: take.contentType,
    durationMs: take.durationMs,
    sizeBytes: take.blob.size,
  });
  const previous = state.benchmarks[month];
  await deps.blobs.put({
    key: blobKey,
    blob: take.blob,
    contentType: take.contentType,
    createdAt: at,
    pinned: true,
  });
  try {
    await deps.append([event]);
  } catch (error) {
    await deps.blobs.delete(blobKey).catch(() => undefined);
    throw error;
  }
  const replaced = previous !== undefined && previous.blobKey !== blobKey ? previous : undefined;
  if (replaced) await deleteBenchmarkBlob(deps, replaced.blobKey);
  return { event, replaced };
}

/** Delete a benchmark's audio here and, when signed in, on the server. Never throws. */
export async function deleteBenchmarkBlob(
  deps: Pick<SaveBenchmarkDeps, "blobs" | "deleteRemote">,
  key: string,
): Promise<void> {
  try {
    await deps.blobs.delete(key);
  } catch (error) {
    console.warn("Could not delete a replaced benchmark here", error);
  }
  try {
    await deps.deleteRemote?.(key);
  } catch (error) {
    console.warn("Could not delete a replaced benchmark on the server", error);
  }
}

/** How long to leave an unreferenced benchmark blob alone (its event may still be on its way). */
export const ORPHAN_GRACE_MS = 60 * 60 * 1000;

/**
 * Benchmark blobs on this device that no kept benchmark names, older than the grace period. They
 * are takes another device replaced (the replacing device cannot reach this one's storage).
 */
export function orphanBenchmarkBlobs(
  blobs: readonly BlobMeta[],
  state: Pick<LearnerState, "benchmarks">,
  now: number,
): string[] {
  const kept = new Set(Object.values(state.benchmarks).map((b) => b.blobKey));
  return blobs
    .filter(
      (b) =>
        b.key.startsWith("benchmark-") && !kept.has(b.key) && now - b.createdAt > ORPHAN_GRACE_MS,
    )
    .map((b) => b.key);
}
