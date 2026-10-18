import { baseContentType, isAllowedBlobType } from "@clavis/core";
import type { BlobRecord, PutBlobInput } from "@clavis/store";
import { BlobAuthError } from "./upload-queue";

/*
 * Reading and deleting recordings on the server (T6.5): `GET` and `DELETE /api/blobs/:name`. The
 * session cookie travels via `credentials: "include"`; the browser adds the Origin header the
 * server checks on DELETE.
 */

export interface RemoteBlob {
  blob: Blob;
  contentType: string;
}

const url = (base: string, key: string): string => `${base}/${encodeURIComponent(key)}`;

/** `GET` a blob. Undefined when the server has none; throws `BlobAuthError` on 401. */
export function createFetchDownloader(
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
  base = "/api/blobs",
): (key: string) => Promise<RemoteBlob | undefined> {
  return async (key) => {
    const res = await fetchFn(url(base, key), { method: "GET", credentials: "include" });
    if (res.status === 404) return undefined;
    if (res.status === 401) throw new BlobAuthError();
    if (!res.ok) throw new Error(`blob download failed with status ${String(res.status)}`);
    const blob = await res.blob();
    return { blob, contentType: baseContentType(res.headers.get("content-type") ?? blob.type) };
  };
}

/** `DELETE` a blob. A missing blob counts as deleted; throws `BlobAuthError` on 401. */
export function createFetchDeleter(
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
  base = "/api/blobs",
): (key: string) => Promise<void> {
  return async (key) => {
    const res = await fetchFn(url(base, key), { method: "DELETE", credentials: "include" });
    if (res.ok || res.status === 404) return;
    if (res.status === 401) throw new BlobAuthError();
    throw new Error(`blob delete failed with status ${String(res.status)}`);
  };
}

export interface LoadBlobDeps {
  store: {
    get(key: string): Promise<BlobRecord | undefined>;
    put(input: PutBlobInput): Promise<unknown>;
  };
  /** Undefined when remote fetching is not possible (signed out). */
  download: ((key: string) => Promise<RemoteBlob | undefined>) | undefined;
}

/**
 * A recording's bytes: from this device when it has them, otherwise downloaded and cached locally,
 * pinned (so eviction never drops it) and marked uploaded (the server already holds it). Undefined
 * when neither has it. `fallbackType` is used when the server's content type is not an audio type
 * the store accepts. Download errors propagate.
 */
export async function loadBlob(
  deps: LoadBlobDeps,
  key: string,
  fallbackType?: string,
): Promise<Blob | undefined> {
  const local = await deps.store.get(key);
  if (local) return local.blob;
  if (!deps.download) return undefined;
  const remote = await deps.download(key);
  if (!remote) return undefined;
  const contentType = isAllowedBlobType(remote.contentType)
    ? remote.contentType
    : (fallbackType ?? remote.contentType);
  try {
    await deps.store.put({ key, blob: remote.blob, contentType, pinned: true, uploaded: true });
  } catch (error) {
    // Still playable this time; it is fetched again next time.
    console.warn("Could not cache a downloaded recording", error);
  }
  return remote.blob;
}
