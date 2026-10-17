import type { BenchmarkRecord, LearnerState } from "@clavis/core";
import { getBlobStore } from "../blobs/app";
import { createFetchDeleter, createFetchDownloader, loadBlob } from "../blobs/remote";
import { isSignedInHint } from "../sync/hint";
import { orphanBenchmarkBlobs } from "./save";

/* Client-only wiring for benchmarks (T6.5): the app's blob store and the server, when signed in. */

/** Remote delete, or undefined while signed out. */
export function remoteDeleter(): ((key: string) => Promise<void>) | undefined {
  return isSignedInHint() ? createFetchDeleter() : undefined;
}

/** A benchmark's audio, from this device or downloaded (then cached and pinned). */
export async function benchmarkAudio(b: BenchmarkRecord): Promise<Blob | undefined> {
  const store = await getBlobStore();
  if (!store) return undefined;
  const download = isSignedInHint() ? createFetchDownloader() : undefined;
  return loadBlob({ store, download }, b.blobKey, b.contentType);
}

/** Delete local benchmark audio that no kept benchmark names any more. Best effort. */
export async function sweepOrphanBenchmarks(
  state: Pick<LearnerState, "benchmarks">,
  now: number,
): Promise<void> {
  try {
    const store = await getBlobStore();
    if (!store) return;
    for (const key of orphanBenchmarkBlobs(await store.list(), state, now)) {
      await store.delete(key);
    }
  } catch (error) {
    console.warn("Could not tidy old benchmark recordings", error);
  }
}
