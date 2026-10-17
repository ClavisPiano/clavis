import { DexieEventStore, type BlobRecord, type BlobStore } from "@clavis/store";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BlobAuthError,
  BlobRejectedError,
  createFetchUploader,
  createUploadQueue,
  type UploadQueue,
} from "./upload-queue";

const opened: DexieEventStore[] = [];
let counter = 0;
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function makeStore(): BlobStore {
  const events = new DexieEventStore({
    name: `clavis-upload-test-${String(++counter)}`,
    indexedDB,
    IDBKeyRange,
  });
  opened.push(events);
  return events.blobStore();
}

const blob = (n = 4) => new Blob([new Uint8Array(n)], { type: "audio/webm" });
async function seed(store: BlobStore, keys: string[]) {
  let at = 1;
  for (const key of keys) await store.put({ key, blob: blob(), createdAt: at++ });
}
const uploadedKeys = async (s: BlobStore) =>
  (await s.list()).filter((m) => m.uploaded).map((m) => m.key);

const noDelay = () => Promise.resolve();

describe("upload queue", () => {
  it("uploads pending blobs oldest first and marks them uploaded", async () => {
    const store = makeStore();
    await seed(store, ["a", "b", "c"]);
    await store.markUploaded("b");
    const sent: string[] = [];
    const q = createUploadQueue({
      store,
      upload: (r) => {
        sent.push(r.key);
        return Promise.resolve();
      },
      delay: noDelay,
    });
    expect(await q.run()).toEqual({ outcome: "ok", uploaded: 2, rejected: 0 });
    expect(sent).toEqual(["a", "c"]);
    expect(await uploadedKeys(store)).toEqual(["a", "b", "c"]);
    // Nothing left: a second run does no work.
    expect((await q.run()).uploaded).toBe(0);
    expect(sent).toHaveLength(2);
  });

  it("a recording replaced while its old bytes upload stays pending for the next run", async () => {
    const store = makeStore();
    await store.put({ key: "take", blob: blob(4), createdAt: 1 });
    const sentSizes: number[] = [];
    const q = createUploadQueue({
      store,
      upload: async (r) => {
        sentSizes.push(r.size);
        // The learner records again under the same key while the first upload is in flight.
        if (sentSizes.length === 1) await store.put({ key: "take", blob: blob(8), createdAt: 2 });
      },
      delay: noDelay,
    });
    await q.run();
    // The old upload finished, but the row now holds new bytes, so it is still pending.
    expect(await store.get("take")).toMatchObject({ size: 8, uploaded: false });
    // The next run (the next sync) uploads the new bytes.
    await q.run();
    expect(sentSizes).toEqual([4, 8]);
    expect(await store.get("take")).toMatchObject({ size: 8, uploaded: true });
  });

  it("retries network failures with backoff, then succeeds", async () => {
    const store = makeStore();
    await seed(store, ["a"]);
    let calls = 0;
    const delays: number[] = [];
    const q = createUploadQueue({
      store,
      upload: () => {
        calls++;
        return calls < 3 ? Promise.reject(new Error("network")) : Promise.resolve();
      },
      delay: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
      baseDelayMs: 100,
    });
    expect(await q.run()).toMatchObject({ outcome: "ok", uploaded: 1 });
    expect(calls).toBe(3);
    expect(delays).toEqual([100, 200]);
    expect(await uploadedKeys(store)).toEqual(["a"]);
  });

  it("ends as error when retries run out, leaving the blob pending and later ones untouched", async () => {
    const store = makeStore();
    await seed(store, ["a", "b"]);
    const sent: string[] = [];
    const q = createUploadQueue({
      store,
      upload: (r) => {
        sent.push(r.key);
        return Promise.reject(new Error("503"));
      },
      delay: noDelay,
      maxAttempts: 2,
    });
    expect(await q.run()).toMatchObject({ outcome: "error", uploaded: 0, detail: "503" });
    expect(sent).toEqual(["a", "a"]);
    expect(await uploadedKeys(store)).toEqual([]);
  });

  it("stops on 401 without retrying or marking anything", async () => {
    const store = makeStore();
    await seed(store, ["a", "b"]);
    const upload = vi.fn(() => Promise.reject(new BlobAuthError()));
    const q = createUploadQueue({ store, upload, delay: noDelay });
    expect(await q.run()).toMatchObject({ outcome: "signedOut", uploaded: 0 });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(await uploadedKeys(store)).toEqual([]);
  });

  it("keeps earlier successes when a later blob hits 401", async () => {
    const store = makeStore();
    await seed(store, ["a", "b"]);
    const q = createUploadQueue({
      store,
      upload: (r) => (r.key === "a" ? Promise.resolve() : Promise.reject(new BlobAuthError())),
      delay: noDelay,
    });
    expect(await q.run()).toMatchObject({ outcome: "signedOut", uploaded: 1 });
    expect(await uploadedKeys(store)).toEqual(["a"]);
  });

  it("skips a rejected blob and continues with the rest", async () => {
    const store = makeStore();
    await seed(store, ["a", "b"]);
    const sent: string[] = [];
    const q = createUploadQueue({
      store,
      upload: (r) => {
        sent.push(r.key);
        return r.key === "a" ? Promise.reject(new BlobRejectedError(413)) : Promise.resolve();
      },
      delay: noDelay,
    });
    expect(await q.run()).toEqual({ outcome: "ok", uploaded: 1, rejected: 1 });
    expect(sent).toEqual(["a", "b"]); // a is not retried within the run
    expect(await uploadedKeys(store)).toEqual(["b"]);
  });

  it("does not upload the same blob twice concurrently", async () => {
    const store = makeStore();
    await seed(store, ["a", "b"]);
    const active = new Map<string, number>();
    let maxActive = 0;
    const calls: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const q = createUploadQueue({
      store,
      upload: async (r) => {
        calls.push(r.key);
        active.set(r.key, (active.get(r.key) ?? 0) + 1);
        maxActive = Math.max(maxActive, ...active.values());
        await gate;
        active.set(r.key, (active.get(r.key) ?? 1) - 1);
      },
      delay: noDelay,
    });
    const first = q.run();
    const second = q.run();
    const third = q.run();
    expect(second).toBe(first);
    expect(third).toBe(first);
    await vi.waitFor(() => {
      expect(calls).toEqual(["a"]);
    });
    release?.();
    expect(await first).toMatchObject({ outcome: "ok", uploaded: 2 });
    expect(maxActive).toBe(1);
    expect(calls).toEqual(["a", "b"]); // the follow-up pass found nothing new to send
  });

  it("picks up a blob added during a run on the follow-up pass", async () => {
    const store = makeStore();
    await seed(store, ["a"]);
    const sent: string[] = [];
    const q: UploadQueue = createUploadQueue({
      store,
      upload: async (r) => {
        sent.push(r.key);
        if (r.key === "a") {
          await store.put({ key: "late", blob: blob(), createdAt: 99 });
          void q.run();
        }
      },
      delay: noDelay,
    });
    await q.run();
    expect(sent).toEqual(["a", "late"]);
  });

  it("skips a blob evicted between listing and upload", async () => {
    const store = makeStore();
    await seed(store, ["a", "b"]);
    const sent: string[] = [];
    const q = createUploadQueue({
      store,
      upload: async (r: BlobRecord) => {
        sent.push(r.key);
        await store.delete("b");
      },
      delay: noDelay,
    });
    expect(await q.run()).toMatchObject({ outcome: "ok", uploaded: 1 });
    expect(sent).toEqual(["a"]);
  });
});

describe("fetch uploader", () => {
  const record: BlobRecord = {
    key: "take 1.webm",
    blob: blob(),
    contentType: "audio/webm",
    size: 4,
    createdAt: 1,
    pinned: false,
    uploaded: false,
  };
  const respond = (status: number) => vi.fn(() => Promise.resolve(new Response(null, { status })));

  it("PUTs the blob with its content type and credentials", async () => {
    const fetchFn = respond(200);
    await createFetchUploader(fetchFn)(record);
    expect(fetchFn).toHaveBeenCalledWith(
      "/api/blobs/take%201.webm",
      expect.objectContaining({
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "audio/webm" },
      }),
    );
  });

  it.each([
    [401, BlobAuthError],
    [413, BlobRejectedError],
    [415, BlobRejectedError],
    [403, BlobRejectedError],
    [500, Error],
    [429, Error],
  ])("maps status %i", async (status, errorClass) => {
    const up = createFetchUploader(respond(status));
    const error = await up(record).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(errorClass);
    if (status === 500 || status === 429) {
      expect(error).not.toBeInstanceOf(BlobRejectedError);
      expect(error).not.toBeInstanceOf(BlobAuthError);
    }
  });

  it("treats a network failure as retryable", async () => {
    const fetchFn = vi.fn(() => Promise.reject(new TypeError("Failed to fetch")));
    const error = await createFetchUploader(fetchFn as unknown as typeof fetch)(record).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(TypeError);
  });
});
