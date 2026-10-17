import { Dexie } from "dexie";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";
import { pickEvictions, type BlobMeta, type BlobStore } from "./blob-store.js";
import { DexieEventStore } from "./dexie-store.js";

const opened: DexieEventStore[] = [];
let counter = 0;
const dbName = () => `clavis-blob-test-${String(++counter)}`;

afterEach(() => {
  for (const store of opened.splice(0)) store.close();
});

function open(maxBytes: number, name = dbName()): { events: DexieEventStore; blobs: BlobStore } {
  const events = new DexieEventStore({ name, indexedDB, IDBKeyRange });
  opened.push(events);
  return { events, blobs: events.blobStore({ maxBytes, now: () => 1000 }) };
}

const blob = (size: number, type = "audio/webm") => new Blob([new Uint8Array(size)], { type });
const keys = async (b: BlobStore) => (await b.list()).map((m) => m.key);

describe("DexieBlobStore", () => {
  it("round-trips a blob with metadata", async () => {
    const { blobs } = open(1000);
    await blobs.put({ key: "a.webm", blob: blob(10), createdAt: 5 });
    const row = await blobs.get("a.webm");
    expect(row).toMatchObject({
      key: "a.webm",
      contentType: "audio/webm",
      size: 10,
      createdAt: 5,
      pinned: false,
      uploaded: false,
    });
    expect(row?.blob.size).toBe(10);
    expect(await blobs.get("missing")).toBeUndefined();
  });

  it("lists metadata only, oldest first", async () => {
    const { blobs } = open(1000);
    await blobs.put({ key: "b", blob: blob(1), createdAt: 20 });
    await blobs.put({ key: "a", blob: blob(1), createdAt: 10 });
    const list = await blobs.list();
    expect(list.map((m) => m.key)).toEqual(["a", "b"]);
    expect("blob" in (list[0] ?? {})).toBe(false);
  });

  it("markUploaded flips the flag", async () => {
    const { blobs } = open(1000);
    await blobs.put({ key: "a", blob: blob(1) });
    await blobs.markUploaded("a");
    expect((await blobs.get("a"))?.uploaded).toBe(true);
  });

  it("markUploaded with a version only marks that version", async () => {
    const { blobs } = open(1000);
    await blobs.put({ key: "a", blob: blob(1), createdAt: 5 });
    await blobs.markUploaded("a", { createdAt: 4, size: 1 });
    expect((await blobs.get("a"))?.uploaded).toBe(false);
    await blobs.markUploaded("a", { createdAt: 5, size: 2 });
    expect((await blobs.get("a"))?.uploaded).toBe(false);
    await blobs.markUploaded("a", { createdAt: 5, size: 1 });
    expect((await blobs.get("a"))?.uploaded).toBe(true);
  });

  it("rejects bad keys and types", async () => {
    const { blobs } = open(1000);
    await expect(blobs.put({ key: "../x", blob: blob(1) })).rejects.toThrow(/invalid blob key/);
    await expect(blobs.put({ key: "a/b", blob: blob(1) })).rejects.toThrow(/invalid blob key/);
    await expect(blobs.put({ key: "a", blob: blob(1, "image/png") })).rejects.toThrow(/type/);
    await expect(
      blobs.put({ key: "a", blob: blob(1, ""), contentType: "audio/ogg" }),
    ).resolves.toEqual({
      evicted: [],
    });
  });

  it("evicts uploaded rows oldest first when over the cap", async () => {
    const { blobs } = open(100);
    await blobs.put({ key: "old", blob: blob(40), createdAt: 1 });
    await blobs.put({ key: "mid", blob: blob(40), createdAt: 2 });
    await blobs.markUploaded("old");
    await blobs.markUploaded("mid");
    const { evicted } = await blobs.put({ key: "new", blob: blob(40), createdAt: 3 });
    expect(evicted).toEqual(["old"]);
    expect(await keys(blobs)).toEqual(["mid", "new"]);
  });

  it("prefers uploaded rows over older un-uploaded ones, and never evicts pinned rows", async () => {
    const { blobs } = open(100);
    await blobs.put({ key: "pinned", blob: blob(40), createdAt: 1, pinned: true });
    await blobs.put({ key: "pending", blob: blob(30), createdAt: 2 });
    await blobs.put({ key: "done", blob: blob(30), createdAt: 3 });
    await blobs.markUploaded("done");
    const { evicted } = await blobs.put({ key: "new", blob: blob(30), createdAt: 4 });
    expect(evicted).toEqual(["done"]);
    expect(await keys(blobs)).toEqual(["pinned", "pending", "new"]);
  });

  it("falls back to un-uploaded rows (oldest first) when nothing uploaded remains", async () => {
    const { blobs } = open(100);
    await blobs.put({ key: "p", blob: blob(50), createdAt: 1, pinned: true });
    await blobs.put({ key: "u1", blob: blob(30), createdAt: 2 });
    const { evicted } = await blobs.put({ key: "u2", blob: blob(30), createdAt: 3 });
    expect(evicted).toEqual(["u1"]);
    expect(await keys(blobs)).toEqual(["p", "u2"]);
  });

  it("keeps the row just written even if it alone exceeds the cap, and pinned rows stay", async () => {
    const { blobs } = open(10);
    await blobs.put({ key: "pin", blob: blob(8), pinned: true, createdAt: 1 });
    const { evicted } = await blobs.put({ key: "big", blob: blob(50), createdAt: 2 });
    expect(evicted).toEqual([]);
    expect(await keys(blobs)).toEqual(["pin", "big"]);
  });

  it("evict() applies a cap that was exceeded earlier", async () => {
    const events = new DexieEventStore({ name: dbName(), indexedDB, IDBKeyRange });
    opened.push(events);
    await events.blobStore({ maxBytes: 1000 }).put({ key: "a", blob: blob(60), createdAt: 1 });
    await events.blobStore({ maxBytes: 1000 }).put({ key: "b", blob: blob(60), createdAt: 2 });
    const small = events.blobStore({ maxBytes: 70 });
    expect(await small.evict()).toEqual(["a"]);
    expect(await keys(small)).toEqual(["b"]);
  });

  it("re-putting a key replaces the row and resets uploaded", async () => {
    const { blobs } = open(1000);
    await blobs.put({ key: "a", blob: blob(5) });
    await blobs.markUploaded("a");
    await blobs.put({ key: "a", blob: blob(7) });
    expect(await blobs.get("a")).toMatchObject({ size: 7, uploaded: false });
  });
});

describe("pickEvictions", () => {
  const row = (
    key: string,
    size: number,
    createdAt: number,
    o: Partial<BlobMeta> = {},
  ): BlobMeta => ({
    key,
    size,
    createdAt,
    contentType: "audio/webm",
    pinned: false,
    uploaded: false,
    ...o,
  });
  it("is table-driven over the policy", () => {
    const rows = [
      row("p", 10, 1, { pinned: true, uploaded: true }),
      row("u-old", 10, 2, { uploaded: true }),
      row("n-old", 10, 3),
      row("u-new", 10, 4, { uploaded: true }),
      row("n-new", 10, 5),
    ];
    expect(pickEvictions(rows, 50)).toEqual([]);
    expect(pickEvictions(rows, 40)).toEqual(["u-old"]);
    expect(pickEvictions(rows, 20)).toEqual(["u-old", "u-new", "n-old"]);
    expect(pickEvictions(rows, 0)).toEqual(["u-old", "u-new", "n-old", "n-new"]);
    expect(pickEvictions(rows, 40, "u-old")).toEqual(["u-new"]);
  });
});

describe("Dexie v2 upgrade", () => {
  it("keeps v1 data and adds the blobs table", async () => {
    const name = dbName();
    const v1 = new Dexie(name, { indexedDB, IDBKeyRange });
    v1.version(1).stores({ events: "id, at, [at+id], synced", snapshots: "key", meta: "key" });
    await v1.table("events").add({ id: "e1", at: 1, synced: 0 });
    await v1.table("meta").add({ key: "k", value: 42 });
    v1.close();

    const store = new DexieEventStore({ name, indexedDB, IDBKeyRange });
    opened.push(store);
    expect(await store.getMeta("k")).toBe(42);
    expect((await store.listUnsynced()).map((e) => e.id)).toEqual(["e1"]);
    const blobs = store.blobStore();
    await blobs.put({ key: "a", blob: blob(3) });
    expect(await keys(blobs)).toEqual(["a"]);
  });
});
