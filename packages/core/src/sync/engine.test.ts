import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MemoryEventStore } from "../events/memory-store.js";
import type { LearningEvent } from "../events/schema.js";
import { encodeTime } from "../events/ulid.js";
import { LearnerStateService } from "../state/service.js";
import { makeSnapshot } from "../state/snapshot.js";
import { ctx } from "../state/test-helpers.js";
import {
  MAX_PUSH_BYTES,
  SyncAuthError,
  SyncRejectedError,
  chunkByBytes,
  utf8Length,
  metaCursorStore,
  syncOnce,
  type SyncTransport,
} from "./engine.js";
import { MAX_PUSH_BATCH, PullRequest, PushRequest, type PullResponse } from "./schema.js";

/** In-memory fake of the T4.1 server: seq assignment, idempotent insert, pagination. */
class FakeServer {
  readonly rows: { seq: number; event: unknown }[] = [];
  private readonly ids = new Set<string>();
  pushCalls = 0;
  pullCalls = 0;
  pushSizes: number[] = [];

  push(raw: unknown): { accepted: number; duplicates: number; lastSeq: number } {
    this.pushCalls++;
    const parsed = PushRequest.safeParse(raw);
    if (!parsed.success) throw new SyncRejectedError(400);
    this.pushSizes.push(parsed.data.events.length);
    let accepted = 0;
    for (const event of parsed.data.events) {
      if (this.ids.has(event.id)) continue;
      this.ids.add(event.id);
      this.rows.push({ seq: this.rows.length + 1, event });
      accepted++;
    }
    return {
      accepted,
      duplicates: parsed.data.events.length - accepted,
      lastSeq: this.rows.length,
    };
  }

  pull(raw: { after: number; limit?: number }): PullResponse {
    this.pullCalls++;
    const q = PullRequest.parse(raw);
    const limit = q.limit ?? 500;
    const rows = this.rows.filter((r) => r.seq > q.after).slice(0, limit + 1);
    const page = rows.slice(0, limit);
    return {
      events: page.map((r) => ({
        serverSeq: r.seq,
        receivedAt: 1,
        event: r.event as PullResponse["events"][number]["event"],
      })),
      lastSeq: page.at(-1)?.seq ?? q.after,
      hasMore: rows.length > limit,
    };
  }
}

interface Link {
  mode: "ok" | "offline" | "unauthorized";
}

function transportFor(server: FakeServer, link: Link): SyncTransport {
  const gate = (): void => {
    if (link.mode === "offline") throw new TypeError("network down");
    if (link.mode === "unauthorized") throw new SyncAuthError("401");
  };
  return {
    push(request) {
      gate();
      return Promise.resolve(server.push(request));
    },
    pull(args) {
      gate();
      return Promise.resolve(server.pull(args));
    },
  };
}

class Client {
  readonly store = new MemoryEventStore();
  readonly service: LearnerStateService;
  readonly link: Link = { mode: "ok" };
  private readonly transport: SyncTransport;
  private n = 0;

  constructor(
    readonly name: string,
    readonly server: FakeServer,
    snapshotEvery?: number,
  ) {
    this.service = new LearnerStateService({
      store: this.store,
      ctx: ctx(),
      ...(snapshotEvery === undefined ? {} : { snapshotEvery }),
    });
    this.transport = transportFor(server, this.link);
  }

  async init(): Promise<this> {
    await this.service.load();
    return this;
  }

  event(at: number, budgetSec: number): LearningEvent {
    this.n++;
    return {
      id: encodeTime(at) + this.name.padEnd(1, "x") + String(this.n).padStart(15, "0"),
      deviceId: `dev-${this.name}`,
      at,
      type: "settings.changed",
      v: 2,
      patch: { budgetSec },
    };
  }

  async add(at: number, budgetSec: number): Promise<LearningEvent> {
    const e = this.event(at, budgetSec);
    await this.service.append([e]);
    return e;
  }

  sync(opts: { pushBatch?: number; pullLimit?: number; maxPushBytes?: number } = {}) {
    return syncOnce({
      store: this.store,
      learner: this.service,
      transport: this.transport,
      cursorStore: metaCursorStore(this.store),
      ...opts,
    });
  }

  async ids(): Promise<string[]> {
    return (await this.store.list()).map((e) => e.id);
  }
}

const T = 1_767_225_600_000;

describe("syncOnce", () => {
  it("pushes unsynced events in batches of at most 500 and marks them synced", async () => {
    const server = new FakeServer();
    const a = await new Client("A", server).init();
    const events = Array.from({ length: 1203 }, (_, i) => a.event(T + i, 600 + (i % 5)));
    await a.service.append(events);
    const r = await a.sync();
    expect(r.outcome).toBe("ok");
    expect(r.pushed).toBe(1203);
    expect(server.pushSizes).toEqual([500, 500, 203]);
    expect(await a.store.listUnsynced()).toEqual([]);
    expect(MAX_PUSH_BATCH).toBe(500);
  });

  it("pulls page by page and persists the cursor", async () => {
    const server = new FakeServer();
    const a = await new Client("A", server).init();
    const b = await new Client("B", server).init();
    for (let i = 0; i < 7; i++) await a.add(T + i, 600 + i);
    await a.sync();
    const r = await b.sync({ pullLimit: 3 });
    expect(r.pulledNew).toBe(7);
    expect(await metaCursorStore(b.store).get()).toBe(7);
    expect((await b.ids()).length).toBe(7);
    expect(await b.store.listUnsynced()).toEqual([]);
    const before = server.pullCalls;
    await b.sync({ pullLimit: 3 });
    expect(server.pullCalls - before).toBe(1);
  });

  it("goes offline without losing events, then pushes them later", async () => {
    const server = new FakeServer();
    const a = await new Client("A", server).init();
    await a.add(T, 700);
    a.link.mode = "offline";
    const r = await a.sync();
    expect(r.outcome).toBe("offline");
    expect((await a.store.listUnsynced()).length).toBe(1);
    expect(server.rows.length).toBe(0);
    a.link.mode = "ok";
    expect((await a.sync()).outcome).toBe("ok");
    expect(server.rows.length).toBe(1);
    expect(await a.store.listUnsynced()).toEqual([]);
  });

  it("stops pushing on a 400 without marking anything synced, reports the batch, still pulls", async () => {
    const rejected: number[] = [];
    let pulls = 0;
    const a = await new Client("A", new FakeServer()).init();
    await a.add(T, 700);
    const r = await syncOnce({
      store: a.store,
      learner: a.service,
      cursorStore: metaCursorStore(a.store),
      transport: {
        push: () => Promise.reject(new SyncRejectedError(400)),
        pull: () => {
          pulls++;
          return Promise.resolve({ events: [], lastSeq: 0, hasMore: false });
        },
      },
      onRejected: (batch) => rejected.push(batch.length),
    });
    expect(r.outcome).toBe("error");
    expect(rejected).toEqual([1]);
    expect(pulls).toBe(1);
    expect((await a.store.listUnsynced()).length).toBe(1);
  });

  it("creates no duplicates after repeated syncs or pulling its own events", async () => {
    const server = new FakeServer();
    const a = await new Client("A", server).init();
    for (let i = 0; i < 4; i++) await a.add(T + i, 600 + i);
    for (let i = 0; i < 3; i++) expect((await a.sync()).outcome).toBe("ok");
    expect(server.rows.length).toBe(4);
    expect((await a.ids()).length).toBe(4);
    expect(await a.store.listUnsynced()).toEqual([]);
    // Forget the cursor: the client re-pulls everything it pushed itself.
    await a.store.setMeta("sync.cursor", 0);
    const r = await a.sync();
    expect(r.pulledNew).toBe(0);
    expect((await a.ids()).length).toBe(4);
    expect(await a.store.listUnsynced()).toEqual([]);
    expect(server.rows.length).toBe(4);
  });

  it("claim (R7): events made while signed out reach the server after sign-in", async () => {
    const server = new FakeServer();
    const a = await new Client("A", server).init();
    const b = await new Client("B", server).init();
    const e1 = await a.add(T, 650);
    const e2 = await a.add(T + 1, 660);
    a.link.mode = "unauthorized";
    expect((await a.sync()).outcome).toBe("signedOut");
    expect((await a.store.listUnsynced()).length).toBe(2);
    expect(server.rows.length).toBe(0);
    a.link.mode = "ok";
    expect((await a.sync()).outcome).toBe("ok");
    await b.sync();
    expect(await b.ids()).toEqual([e1.id, e2.id]);
    expect(b.service.state).toEqual(a.service.state);
  });

  it("clears a stale snapshot when a pulled event sorts before it", async () => {
    const server = new FakeServer();
    const a = await new Client("A", server).init();
    const b = await new Client("B", server, 1).init();
    await b.add(T + 100, 800); // snapshot written at this event
    const old = await a.add(T, 500);
    await a.sync();
    await b.sync();
    const reloaded = new LearnerStateService({ store: b.store, ctx: ctx() });
    await reloaded.load();
    expect((await b.ids()).includes(old.id)).toBe(true);
    expect(reloaded.state).toEqual(b.service.state);
    expect(makeSnapshot(reloaded.state, ctx().graph.contentVersion).lastEventId).toBe(
      reloaded.state.lastEvent?.id,
    );
  });

  it("skips pulled events it cannot parse but still advances the cursor", async () => {
    const server = new FakeServer();
    server.push({
      events: [
        {
          id: encodeTime(T) + "Z" + "0".repeat(15),
          deviceId: "d",
          at: T,
          type: "future.thing",
          v: 9,
        },
      ],
    });
    const a = await new Client("A", server).init();
    const r = await a.sync();
    expect(r).toMatchObject({ outcome: "ok", skipped: 1, pulledNew: 0 });
    expect(await metaCursorStore(a.store).get()).toBe(1);
  });

  it("converges two clients under any interleaving (property)", async () => {
    const action = fc.oneof(
      fc.record({ k: fc.constant("addA" as const), at: fc.integer({ min: 0, max: 50 }) }),
      fc.record({ k: fc.constant("addB" as const), at: fc.integer({ min: 0, max: 50 }) }),
      fc.record({ k: fc.constant("syncA" as const) }),
      fc.record({ k: fc.constant("syncB" as const) }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(action, { maxLength: 25 }), async (actions) => {
        const server = new FakeServer();
        const a = await new Client("A", server, 3).init();
        const b = await new Client("B", server, 3).init();
        let budget = 600;
        for (const act of actions) {
          if (act.k === "addA") await a.add(T + act.at, budget++);
          else if (act.k === "addB") await b.add(T + act.at, budget++);
          else if (act.k === "syncA") await a.sync({ pullLimit: 2 });
          else await b.sync({ pullLimit: 2 });
        }
        for (let i = 0; i < 2; i++) {
          await a.sync({ pullLimit: 2 });
          await b.sync({ pullLimit: 2 });
        }
        expect(await a.ids()).toEqual(await b.ids());
        expect(a.service.state).toEqual(b.service.state);
        expect(await a.store.listUnsynced()).toEqual([]);
        expect(await b.store.listUnsynced()).toEqual([]);
        // A fresh load (snapshot plus tail) agrees with the live state.
        const fresh = new LearnerStateService({ store: b.store, ctx: ctx(), snapshotEvery: 3 });
        await fresh.load();
        expect(fresh.state).toEqual(b.service.state);
        expect(server.rows.length).toBe((await a.ids()).length);
      }),
      { numRuns: 60 },
    );
  });
});

describe("byte-bounded pushes", () => {
  const sized = (n: number): LearningEvent[] =>
    Array.from({ length: n }, (_, i) => ({
      id: encodeTime(T + i) + "A" + String(i).padStart(15, "0"),
      deviceId: "dev-A",
      at: T + i,
      type: "settings.changed",
      v: 2,
      patch: { budgetSec: 700 + i },
    }));
  const bytes = (e: unknown): number => utf8Length(JSON.stringify(e));

  it("chunkByBytes keeps order, loses nothing and respects the cap (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 40 }),
        fc.integer({ min: 200, max: 3000 }),
        (n, cap) => {
          const events = sized(n);
          const chunks = chunkByBytes(events, cap);
          expect(chunks.flat()).toEqual(events);
          for (const c of chunks) {
            if (c.length > 1) expect(bytes(c)).toBeLessThanOrEqual(cap);
          }
        },
      ),
    );
  });

  it("splits a large batch into several pushes under the byte cap", async () => {
    const server = new FakeServer();
    const a = await new Client("A", server).init();
    await a.service.append(sized(30));
    const r = await a.sync({ maxPushBytes: 1000 });
    expect(r.outcome).toBe("ok");
    expect(server.rows.length).toBe(30);
    expect(server.pushCalls).toBeGreaterThan(3);
    expect(MAX_PUSH_BYTES).toBeLessThan(2 * 1024 * 1024);
  });

  it("halves a chunk the server answers 413 for", async () => {
    const server = new FakeServer();
    const a = await new Client("A", server).init();
    await a.service.append(sized(8));
    const r = await syncOnce({
      store: a.store,
      learner: a.service,
      cursorStore: metaCursorStore(a.store),
      transport: {
        push: (req) =>
          req.events.length > 2
            ? Promise.reject(new SyncRejectedError(413))
            : Promise.resolve(server.push(req)),
        pull: (args) => Promise.resolve(server.pull(args)),
      },
    });
    expect(r.outcome).toBe("ok");
    expect(server.rows.length).toBe(8);
    expect(await a.store.listUnsynced()).toEqual([]);
  });

  it("skips a single event the server refuses with 413 and still pushes newer ones", async () => {
    const server = new FakeServer();
    const a = await new Client("A", server).init();
    const all = sized(4);
    const big = all[0];
    await a.service.append(all);
    const seen: string[] = [];
    const r = await syncOnce({
      store: a.store,
      learner: a.service,
      cursorStore: metaCursorStore(a.store),
      onOversized: (e) => seen.push(e.id),
      transport: {
        push: (req) =>
          req.events.some((e) => e.id === big?.id)
            ? Promise.reject(new SyncRejectedError(413))
            : Promise.resolve(server.push(req)),
        pull: (args) => Promise.resolve(server.pull(args)),
      },
    });
    expect(r.outcome).toBe("ok");
    expect(r.oversized).toBe(1);
    expect(seen).toEqual([big?.id]);
    expect(server.rows.length).toBe(3);
    expect((await a.store.listUnsynced()).map((e) => e.id)).toEqual([big?.id]);
  });
});
