import { DexieEventStore, type BlobStore } from "@clavis/store";
import { initAppStore } from "../app-store";
import { createFetchUploader, createUploadQueue, type UploadQueue } from "./upload-queue";

let blobs: Promise<BlobStore | undefined> | undefined;
let queue: UploadQueue | undefined;

/** Client-only. The local recording store, or undefined when storage is unavailable. */
export function getBlobStore(): Promise<BlobStore | undefined> {
  blobs ??= initAppStore().then((r) =>
    r.ok && r.store instanceof DexieEventStore ? r.store.blobStore() : undefined,
  );
  return blobs;
}

/** Upload pending recordings. Wired as the sync controller's `afterSync`. */
export async function uploadPendingBlobs(): Promise<void> {
  const store = await getBlobStore();
  if (!store) return;
  queue ??= createUploadQueue({ store, upload: createFetchUploader() });
  await queue.run();
}
