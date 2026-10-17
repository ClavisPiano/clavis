import { DexieEventStore, type BlobStore } from "@clavis/store";
import { initAppStore } from "../app-store";
import {
  createFetchUploader,
  createUploadQueue,
  type UploadQueue,
  type UploadRunResult,
} from "./upload-queue";

let blobs: Promise<BlobStore | undefined> | undefined;
let queue: UploadQueue | undefined;

/** Client-only. The local recording store, or undefined when storage is unavailable. */
export function getBlobStore(): Promise<BlobStore | undefined> {
  blobs ??= initAppStore().then((r) =>
    r.ok && r.store instanceof DexieEventStore ? r.store.blobStore() : undefined,
  );
  return blobs;
}

/**
 * Upload pending recordings. Wired as the sync controller's `afterSync`. Failures are logged, not
 * thrown: the next sync retries, and a 401 here is also seen (and handled) by the next sync run.
 */
export async function uploadPendingBlobs(): Promise<UploadRunResult | undefined> {
  const store = await getBlobStore();
  if (!store) return undefined;
  queue ??= createUploadQueue({ store, upload: createFetchUploader() });
  const result = await queue.run();
  if (result.outcome !== "ok" || result.rejected > 0) {
    console.warn("Recording upload did not finish", result);
  }
  return result;
}
