import { DexieEventStore, type BlobStore } from "@clavis/store";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFetchDeleter, createFetchDownloader, loadBlob, type RemoteBlob } from "./remote";
import { BlobAuthError } from "./upload-queue";

const opened: DexieEventStore[] = [];
let counter = 0;
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function makeStore(): BlobStore {
  const events = new DexieEventStore({
    name: `clavis-remote-test-${String(++counter)}`,
    indexedDB,
    IDBKeyRange,
  });
  opened.push(events);
  return events.blobStore();
}

const KEY = "benchmark-01JBX00000000000000000BM01.webm";
const bytes = (n: number, type = "audio/webm") => new Blob([new Uint8Array(n).fill(7)], { type });

describe("loadBlob", () => {
  it("returns the local copy without touching the network", async () => {
    const store = makeStore();
    await store.put({ key: KEY, blob: bytes(5), pinned: true });
    const download = vi.fn<(key: string) => Promise<RemoteBlob | undefined>>();
    const blob = await loadBlob({ store, download }, KEY);
    expect(blob?.size).toBe(5);
    expect(download).not.toHaveBeenCalled();
  });

  it("fetches a missing blob, then caches it pinned and already uploaded", async () => {
    const store = makeStore();
    const download = vi.fn((key: string) => {
      expect(key).toBe(KEY);
      return Promise.resolve({ blob: bytes(9), contentType: "audio/webm" });
    });
    const blob = await loadBlob({ store, download }, KEY);
    expect(blob?.size).toBe(9);
    expect(await store.get(KEY)).toMatchObject({
      size: 9,
      contentType: "audio/webm",
      pinned: true,
      uploaded: true,
    });
    // The second time it is a local hit.
    await loadBlob({ store, download }, KEY);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("uses the expected type when the server's is not an audio type", async () => {
    const store = makeStore();
    const download = () =>
      Promise.resolve({ blob: bytes(3, ""), contentType: "application/octet-stream" });
    await loadBlob({ store, download }, KEY, "audio/mp4");
    expect(await store.get(KEY)).toMatchObject({ contentType: "audio/mp4", pinned: true });
  });

  it("is undefined when neither this device nor the server has it, or when signed out", async () => {
    const store = makeStore();
    expect(await loadBlob({ store, download: () => Promise.resolve(undefined) }, KEY)).toBe(
      undefined,
    );
    expect(await loadBlob({ store, download: undefined }, KEY)).toBeUndefined();
    expect(await store.get(KEY)).toBeUndefined();
  });
});

describe("fetch downloader and deleter", () => {
  const respond = (status: number, body: BodyInit | null = null, type?: string) =>
    vi.fn(() =>
      Promise.resolve(
        new Response(body, { status, headers: type ? { "content-type": type } : {} }),
      ),
    );

  it("GETs the blob with credentials and reads its type", async () => {
    const fetchFn = respond(200, new Uint8Array([1, 2, 3]), "audio/webm; codecs=opus");
    const got = await createFetchDownloader(fetchFn)("take 1.webm");
    expect(fetchFn).toHaveBeenCalledWith("/api/blobs/take%201.webm", {
      method: "GET",
      credentials: "include",
    });
    expect(got?.contentType).toBe("audio/webm");
    expect(got?.blob.size).toBe(3);
  });

  it("maps download statuses", async () => {
    expect(await createFetchDownloader(respond(404))(KEY)).toBeUndefined();
    await expect(createFetchDownloader(respond(401))(KEY)).rejects.toBeInstanceOf(BlobAuthError);
    await expect(createFetchDownloader(respond(500))(KEY)).rejects.toThrow("500");
  });

  it("DELETEs with credentials; a missing blob counts as deleted", async () => {
    const fetchFn = respond(204);
    await createFetchDeleter(fetchFn)(KEY);
    expect(fetchFn).toHaveBeenCalledWith(`/api/blobs/${KEY}`, {
      method: "DELETE",
      credentials: "include",
    });
    await expect(createFetchDeleter(respond(404))(KEY)).resolves.toBeUndefined();
    await expect(createFetchDeleter(respond(401))(KEY)).rejects.toBeInstanceOf(BlobAuthError);
    await expect(createFetchDeleter(respond(503))(KEY)).rejects.toThrow("503");
  });
});
