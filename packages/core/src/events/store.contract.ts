import { beforeEach, describe, expect, it } from "vitest";
import type { LearningEvent } from "./schema.js";
import { InvalidEventError, type EventStore, type Snapshot } from "./store.js";
import { encodeTime } from "./ulid.js";

/** Build a valid event whose ULID sorts by `seq`. */
function ev(seq: number, at: number, patch: { budgetSec?: number } = {}): LearningEvent {
  return {
    id: encodeTime(seq) + "0000000000000000",
    deviceId: "dev1",
    at,
    type: "settings.changed",
    v: 2,
    patch: { budgetSec: 600, ...patch },
  };
}

const snapshot = (key: string, lastEventAt = 1): Snapshot => ({
  key,
  reducerVersion: 1,
  contentVersion: "c1",
  lastEventAt,
  lastEventId: encodeTime(lastEventAt) + "0000000000000000",
  state: { n: lastEventAt, nested: { a: [1, 2] } },
});

/**
 * Shared behavior every `EventStore` implementation must satisfy.
 * `makeStore` must return an empty, isolated store each call.
 */
export function describeEventStoreContract(
  name: string,
  makeStore: () => Promise<EventStore>,
): void {
  describe(`EventStore contract: ${name}`, () => {
    let store: EventStore;
    beforeEach(async () => {
      store = await makeStore();
    });

    describe("append and list", () => {
      it("returns events ordered by (at, id) regardless of insert order", async () => {
        const a = ev(1, 300);
        const b = ev(2, 100);
        const c = ev(3, 200);
        await store.append([a, b]);
        await store.append([c]);
        expect((await store.list()).map((e) => e.id)).toEqual([b.id, c.id, a.id]);
      });

      it("breaks ties on equal `at` by id", async () => {
        const e1 = ev(1, 100);
        const e2 = ev(2, 100);
        const e3 = ev(3, 100);
        await store.append([e3, e1, e2]);
        expect((await store.list()).map((e) => e.id)).toEqual([e1.id, e2.id, e3.id]);
      });

      it("counts inserted events", async () => {
        expect(await store.append([ev(1, 1), ev(2, 2)])).toEqual({ inserted: 2 });
        expect(await store.append([])).toEqual({ inserted: 0 });
      });

      it("filters with fromAt, afterId and limit", async () => {
        const events = [ev(1, 10), ev(2, 20), ev(3, 20), ev(4, 30)];
        await store.append(events);
        const ids = (es: LearningEvent[]) => es.map((e) => e.id);
        expect(ids(await store.list({ fromAt: 20 }))).toEqual(ids(events.slice(1)));
        expect(ids(await store.list({ afterId: events[1]?.id ?? "" }))).toEqual(
          ids(events.slice(2)),
        );
        expect(ids(await store.list({ limit: 2 }))).toEqual(ids(events.slice(0, 2)));
        expect(
          ids(await store.list({ fromAt: 20, afterId: events[1]?.id ?? "", limit: 1 })),
        ).toEqual(ids(events.slice(2, 3)));
      });

      it("round-trips event content", async () => {
        const e = ev(1, 5, { budgetSec: 900 });
        await store.append([e]);
        expect(await store.list()).toEqual([e]);
      });
    });

    describe("idempotency", () => {
      it("ignores duplicate ids across calls", async () => {
        const e = ev(1, 1);
        expect(await store.append([e])).toEqual({ inserted: 1 });
        expect(await store.append([e])).toEqual({ inserted: 0 });
        expect(await store.list()).toHaveLength(1);
      });

      it("ignores duplicate ids within one batch and keeps the first", async () => {
        const first = ev(1, 1, { budgetSec: 100 });
        const dup = { ...first, patch: { budgetSec: 200 } };
        expect(await store.append([first, dup])).toEqual({ inserted: 1 });
        expect(await store.list()).toEqual([first]);
      });

      it("does not reset the synced flag when a synced event is re-appended", async () => {
        const e = ev(1, 1);
        await store.append([e]);
        await store.markSynced([e.id]);
        await store.append([e]);
        expect(await store.listUnsynced()).toEqual([]);
      });
    });

    describe("validation", () => {
      it("rejects the whole batch and inserts nothing when any event is invalid", async () => {
        const good = ev(1, 1);
        const bad = { ...ev(2, 2), id: "not-a-ulid" };
        await expect(store.append([good, bad])).rejects.toBeInstanceOf(InvalidEventError);
        expect(await store.list()).toEqual([]);
        expect(await store.listUnsynced()).toEqual([]);
      });

      it("rejects unknown types and extra keys", async () => {
        const unknownType = { ...ev(1, 1), type: "nope" } as unknown as LearningEvent;
        const extra = { ...ev(2, 2), userId: "u1" } as unknown as LearningEvent;
        await expect(store.append([unknownType])).rejects.toBeInstanceOf(InvalidEventError);
        await expect(store.append([extra])).rejects.toBeInstanceOf(InvalidEventError);
        expect(await store.list()).toEqual([]);
      });
    });

    describe("sync state", () => {
      it("lists new events as unsynced in (at, id) order with an optional limit", async () => {
        const a = ev(1, 30);
        const b = ev(2, 10);
        const c = ev(3, 20);
        await store.append([a, b, c]);
        expect((await store.listUnsynced()).map((e) => e.id)).toEqual([b.id, c.id, a.id]);
        expect((await store.listUnsynced(2)).map((e) => e.id)).toEqual([b.id, c.id]);
      });

      it("markSynced removes events from the unsynced list but not from list()", async () => {
        const a = ev(1, 1);
        const b = ev(2, 2);
        await store.append([a, b]);
        await store.markSynced([a.id]);
        expect((await store.listUnsynced()).map((e) => e.id)).toEqual([b.id]);
        expect(await store.list()).toHaveLength(2);
      });

      it("markSynced ignores unknown ids", async () => {
        const a = ev(1, 1);
        await store.append([a]);
        await store.markSynced(["01ARYZ6S41TSV4RRFFQ69G5FAV", a.id]);
        expect(await store.listUnsynced()).toEqual([]);
      });
    });

    describe("snapshots", () => {
      it("returns undefined for a missing key", async () => {
        expect(await store.getSnapshot("nope")).toBeUndefined();
      });

      it("puts, gets and replaces by key", async () => {
        await store.putSnapshot(snapshot("a", 1));
        await store.putSnapshot(snapshot("b", 2));
        expect(await store.getSnapshot("a")).toEqual(snapshot("a", 1));
        await store.putSnapshot(snapshot("a", 3));
        expect(await store.getSnapshot("a")).toEqual(snapshot("a", 3));
        expect(await store.getSnapshot("b")).toEqual(snapshot("b", 2));
      });

      it("clearSnapshots removes snapshots but keeps events and meta", async () => {
        await store.append([ev(1, 1)]);
        await store.setMeta("k", "v");
        await store.putSnapshot(snapshot("a"));
        await store.clearSnapshots();
        expect(await store.getSnapshot("a")).toBeUndefined();
        expect(await store.list()).toHaveLength(1);
        expect(await store.getMeta("k")).toBe("v");
      });
    });

    describe("meta", () => {
      it("returns undefined for a missing key", async () => {
        expect(await store.getMeta("nope")).toBeUndefined();
      });

      it("sets, gets and overwrites values of several shapes", async () => {
        await store.setMeta("s", "abc");
        await store.setMeta("n", 42);
        await store.setMeta("o", { latencyMs: 12.5 });
        expect(await store.getMeta("s")).toBe("abc");
        expect(await store.getMeta("n")).toBe(42);
        expect(await store.getMeta("o")).toEqual({ latencyMs: 12.5 });
        await store.setMeta("s", "xyz");
        expect(await store.getMeta("s")).toBe("xyz");
      });
    });

    describe("clear", () => {
      it("removes events, unsynced state, snapshots and meta", async () => {
        const e = ev(1, 1);
        await store.append([e]);
        await store.putSnapshot(snapshot("a"));
        await store.setMeta("k", 1);
        await store.clear();
        expect(await store.list()).toEqual([]);
        expect(await store.listUnsynced()).toEqual([]);
        expect(await store.getSnapshot("a")).toBeUndefined();
        expect(await store.getMeta("k")).toBeUndefined();
        expect(await store.append([e])).toEqual({ inserted: 1 });
      });
    });
  });
}
