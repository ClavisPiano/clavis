import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { SyncEnvelope } from "@clavis/core";
import { EventLog, QuotaExceededError } from "./event-log";
import { nodeSql } from "./test-support";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = (n: number): string => {
  let s = "";
  let rest = n;
  for (let i = 0; i < 16; i++) {
    s = ALPHABET.charAt(rest % 32) + s;
    rest = Math.floor(rest / 32);
  }
  return `01ARYZ6S41${s}`;
};
const ev = (n: number): SyncEnvelope => ({
  id: ulid(n),
  deviceId: "dev1",
  at: 1_700_000_000_000 + n,
  type: "device.registered",
  v: 1,
  platform: "web",
});

const newLog = () => new EventLog(nodeSql());

describe("EventLog", () => {
  it("assigns increasing seqs and reports counts", () => {
    const log = newLog();
    expect(log.push([ev(1), ev(2), ev(3)], 10)).toEqual({ accepted: 3, duplicates: 0, lastSeq: 3 });
    expect(log.push([], 11)).toEqual({ accepted: 0, duplicates: 0, lastSeq: 3 });
  });

  it("is idempotent: a repeated push adds nothing", () => {
    const log = newLog();
    log.push([ev(1), ev(2)], 10);
    const before = log.pull(0);
    expect(log.push([ev(1), ev(2)], 20)).toEqual({ accepted: 0, duplicates: 2, lastSeq: 2 });
    expect(log.pull(0)).toEqual(before);
    // Duplicates inside one batch and mixed batches.
    expect(log.push([ev(3), ev(3), ev(1)], 30)).toEqual({ accepted: 1, duplicates: 2, lastSeq: 3 });
  });

  it("keeps the original receivedAt and body for duplicates", () => {
    const log = newLog();
    log.push([ev(1)], 10);
    log.push([{ ...ev(1), platform: "changed" }], 99);
    const [entry] = log.pull(0).events;
    expect(entry?.receivedAt).toBe(10);
    expect(entry?.event).toEqual(ev(1));
  });

  it("paginates with hasMore and lastSeq", () => {
    const log = newLog();
    log.push([1, 2, 3, 4, 5].map(ev), 10);
    const p1 = log.pull(0, 2);
    expect(p1.events.map((e) => e.serverSeq)).toEqual([1, 2]);
    expect(p1).toMatchObject({ lastSeq: 2, hasMore: true });
    const p2 = log.pull(p1.lastSeq, 2);
    expect(p2.events.map((e) => e.serverSeq)).toEqual([3, 4]);
    expect(p2).toMatchObject({ lastSeq: 4, hasMore: true });
    const p3 = log.pull(p2.lastSeq, 2);
    expect(p3.events.map((e) => e.serverSeq)).toEqual([5]);
    expect(p3).toMatchObject({ lastSeq: 5, hasMore: false });
    const exact = log.pull(3, 2);
    expect(exact).toMatchObject({ lastSeq: 5, hasMore: false });
    expect(log.pull(5)).toEqual({ events: [], lastSeq: 5, hasMore: false });
    expect(log.pull(99)).toEqual({ events: [], lastSeq: 99, hasMore: false });
  });

  it("rolls back a failed batch", () => {
    const log = newLog();
    const bad = { ...ev(2), at: {} } as unknown as SyncEnvelope;
    // An unbindable value throws mid-batch (OR IGNORE would swallow constraint errors).
    expect(() => log.push([ev(1), bad], 10)).toThrow();
    expect(log.pull(0).events).toEqual([]);
  });

  it("property: any batching and order yields the same unique id set", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 30 }), { maxLength: 60 }),
        fc.array(fc.integer({ min: 1, max: 7 }), { minLength: 1, maxLength: 20 }),
        fc.integer({ min: 1, max: 9 }),
        (ids, sizes, pageSize) => {
          const log = newLog();
          let i = 0;
          let s = 0;
          while (i < ids.length) {
            const size = sizes[s++ % sizes.length] ?? 1;
            log.push(ids.slice(i, i + size).map(ev), 1);
            i += size;
          }
          const pulled: string[] = [];
          const seqs: number[] = [];
          let after = 0;
          for (;;) {
            const page = log.pull(after, pageSize);
            for (const e of page.events) {
              pulled.push(e.event.id);
              seqs.push(e.serverSeq);
            }
            after = page.lastSeq;
            if (!page.hasMore) break;
          }
          expect(new Set(pulled).size).toBe(pulled.length);
          expect([...pulled].sort()).toEqual([...new Set(ids.map(ulid))].sort());
          expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
        },
      ),
    );
  });
});

describe("EventLog quotas", () => {
  it("refuses a push that would pass the event ceiling and stores none of it", () => {
    const log = new EventLog(nodeSql(), { maxEvents: 3, maxBytes: 1_000_000 });
    expect(log.push([ev(1), ev(2)], 1).accepted).toBe(2);
    expect(() => log.push([ev(3), ev(4)], 2)).toThrow(QuotaExceededError);
    // The failed batch rolled back, so one more event still fits.
    expect(log.push([ev(3)], 3).accepted).toBe(1);
    expect(log.pull(0).events.map((e) => e.event.id)).toEqual([ulid(1), ulid(2), ulid(3)]);
  });

  it("refuses a push that would pass the byte ceiling", () => {
    const log = new EventLog(nodeSql(), { maxEvents: 100, maxBytes: 300 });
    expect(() => log.push([1, 2, 3, 4].map(ev), 1)).toThrow(QuotaExceededError);
    expect(log.pull(0).events).toEqual([]);
  });

  it("does not count duplicates against the ceiling", () => {
    const log = new EventLog(nodeSql(), { maxEvents: 2, maxBytes: 1_000_000 });
    log.push([ev(1), ev(2)], 1);
    expect(log.push([ev(1), ev(2)], 2)).toMatchObject({ accepted: 0, duplicates: 2 });
  });

  it("counts a log that predates the stats table", () => {
    const sql = nodeSql();
    new EventLog(sql).push([ev(1), ev(2)], 1);
    sql.exec("DROP TABLE stats");
    const reopened = new EventLog(sql, { maxEvents: 2, maxBytes: 1_000_000 });
    expect(() => reopened.push([ev(3)], 2)).toThrow(QuotaExceededError);
  });
});
