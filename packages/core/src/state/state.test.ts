import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MemoryEventStore } from "../events/memory-store.js";
import type { LearningEvent } from "../events/schema.js";
import type { Snapshot } from "../events/store.js";
import { compareEvents, validateBatch } from "../events/validate.js";
import {
  REDUCER_VERSION,
  LearnerStateService,
  applyEvent,
  foldEvents,
  makeSnapshot,
  medianDurationSec,
  restoreSnapshot,
  type LearnerState,
} from "./index.js";
import {
  Builder,
  DAY_MS,
  FIXTURE_GRAPH,
  KEY_C,
  KEY_D,
  KEY_E,
  NODE_IDS,
  T0,
  ctx,
  type Key,
} from "./test-helpers.js";

const C = ctx();
const fold = (events: readonly LearningEvent[]): LearnerState => foldEvents(events, C);

/* ---------- generators ---------- */

const KEYS: Key[] = [
  KEY_C,
  KEY_D,
  KEY_E,
  { tonic: "A", mode: "minor" },
  { tonic: "Bb", mode: "major" },
];

const itemPlan = fc.record({
  node: fc.integer({ min: 0, max: 4 }),
  item: fc.integer({ min: 0, max: 3 }),
  isNew: fc.boolean(),
  correct: fc.boolean(),
  latencyMs: fc.integer({ min: 200, max: 6000 }),
  retries: fc.integer({ min: 0, max: 2 }),
  partial: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: undefined }),
  tonicIdx: fc.option(fc.integer({ min: 0, max: KEYS.length - 1 }), { nil: undefined }),
});

const sessionPlan = fc.record({
  day: fc.integer({ min: 0, max: 5 }),
  hour: fc.integer({ min: 5, max: 20 }),
  mode: fc.constantFrom("instrument" as const, "away" as const),
  tz: fc.constantFrom(0, 600, -300),
  keyIdx: fc.integer({ min: 0, max: KEYS.length - 1 }),
  items: fc.array(itemPlan, { minLength: 0, maxLength: 8 }),
  introduce: fc.array(fc.integer({ min: 0, max: 4 }), { maxLength: 2 }),
  settingsBudget: fc.option(fc.integer({ min: 60, max: 3600 }), { nil: undefined }),
  ended: fc.boolean(),
});

type Plan = typeof sessionPlan extends fc.Arbitrary<infer T> ? T : never;

function buildDevice(tag: string, plans: readonly Plan[]): LearningEvent[] {
  const b = new Builder(`dev-${tag}`, tag);
  const out: LearningEvent[] = [];
  let t = T0;
  out.push(b.register(t));
  const sorted = [...plans].sort((x, y) => x.day * 24 + x.hour - (y.day * 24 + y.hour));
  sorted.forEach((p, i) => {
    t = Math.max(t + 1000, T0 + p.day * DAY_MS + p.hour * 3_600_000);
    const sid = b.sessionId(i);
    out.push(b.start(t, sid, { mode: p.mode, key: KEYS[p.keyIdx] ?? KEY_C, tz: p.tz }));
    t += 1000;
    if (p.settingsBudget !== undefined) {
      out.push(b.settings(t, { budgetSec: p.settingsBudget }));
      t += 1000;
    }
    for (const n of p.introduce) {
      out.push(b.introduce(t, sid, NODE_IDS[n] ?? "n1"));
      t += 1000;
    }
    for (const it of p.items) {
      const nodeId = NODE_IDS[it.node] ?? "n1";
      const tonic = it.tonicIdx === undefined ? undefined : KEYS[it.tonicIdx];
      out.push(
        ...b.item(t, sid, nodeId, `${nodeId}:${String(it.item)}`, {
          correct: it.correct,
          latencyMs: it.latencyMs,
          retries: it.retries,
          isNew: it.isNew,
          ...(it.partial !== undefined ? { partial: it.partial } : {}),
          ...(tonic ? { presentation: { tonic: tonic.tonic, mode: tonic.mode } } : {}),
        }),
      );
      t += it.latencyMs + 3000;
    }
    if (p.ended) out.push(b.end(t, sid));
  });
  return out;
}

const deviceArb = (tag: string): fc.Arbitrary<LearningEvent[]> =>
  fc.array(sessionPlan, { minLength: 1, maxLength: 6 }).map((plans) => buildDevice(tag, plans));

const twoDevices = fc.tuple(deviceArb("A"), deviceArb("B"));

const shuffled = <T>(xs: readonly T[], keys: readonly number[]): T[] =>
  xs
    .map((x, i) => [x, keys[i % keys.length] ?? 0, i] as const)
    .sort((a, b) => a[1] - b[1] || a[2] - b[2])
    .map(([x]) => x);

const RUNS = 150;

describe("generated streams are valid", () => {
  it("pass event validation", () => {
    fc.assert(
      fc.property(twoDevices, ([a, b]) => {
        expect(() => validateBatch([...a, ...b])).not.toThrow();
      }),
      { numRuns: 50 },
    );
  });
});

/* ---------- properties ---------- */

describe("fold properties", () => {
  it("is independent of input order across devices", () => {
    fc.assert(
      fc.property(
        twoDevices,
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 40 }),
        ([a, b], keys) => {
          const canonical = fold([...a, ...b].sort(compareEvents));
          const mixed = fold(shuffled([...a, ...b], keys));
          expect(mixed).toStrictEqual(canonical);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("applyEvent one by one in order equals foldEvents", () => {
    fc.assert(
      fc.property(twoDevices, ([a, b]) => {
        const sorted = [...a, ...b].sort(compareEvents);
        let s = fold([]);
        for (const e of sorted) s = applyEvent(s, e, C);
        expect(s).toStrictEqual(fold(sorted));
      }),
      { numRuns: 40 },
    );
  });

  it("is idempotent under duplicate replay", () => {
    fc.assert(
      fc.property(
        twoDevices,
        fc.array(fc.nat(500), { maxLength: 30 }),
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 40 }),
        ([a, b], dupIdx, keys) => {
          const all = [...a, ...b];
          const dups = dupIdx.flatMap((i) => all.slice(i % all.length, (i % all.length) + 1));
          const noisy = shuffled([...all, ...dups], keys);
          expect(fold(noisy)).toStrictEqual(fold(all));
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("snapshot plus tail equals the full fold, and state survives JSON", () => {
    fc.assert(
      fc.property(twoDevices, fc.nat(1000), ([a, b], cutRaw) => {
        const sorted = [...a, ...b].sort(compareEvents);
        const cut = cutRaw % (sorted.length + 1);
        const full = fold(sorted);
        const prefix = fold(sorted.slice(0, cut));
        const snap = makeSnapshot(prefix, C.graph.contentVersion);
        const restored = restoreSnapshot(
          JSON.parse(JSON.stringify(snap)) as Snapshot,
          C.graph.contentVersion,
        );
        expect(restored).toBeDefined();
        if (!restored) throw new Error("snapshot rejected");
        let s = restored;
        for (const e of sorted.slice(cut)) s = applyEvent(s, e, C);
        expect(s).toStrictEqual(full);
        expect(JSON.parse(JSON.stringify(full))).toStrictEqual(full);
      }),
      { numRuns: RUNS },
    );
  });

  it("never lets a started node fall back to locked or available", () => {
    fc.assert(
      fc.property(twoDevices, ([a, b]) => {
        const sorted = [...a, ...b].sort(compareEvents);
        let prev = fold([]);
        for (const e of sorted) {
          const next = applyEvent(prev, e, C);
          for (const [id, rec] of Object.entries(prev.nodes)) {
            if (["learning", "fluent", "mastered"].includes(rec.state)) {
              expect(["learning", "fluent", "mastered"]).toContain(next.nodes[id]?.state);
            }
          }
          prev = next;
        }
      }),
      { numRuns: 40 },
    );
  });
});

/* ---------- service ---------- */

describe("practice sessions (T2.15)", () => {
  const DAY1 = T0 + 6 * 3_600_000;
  const DAY2 = T0 + DAY_MS + 6 * 3_600_000;

  it("keeps REDUCER_VERSION at 2 or more so v1 snapshots are discarded", () => {
    expect(REDUCER_VERSION).toBeGreaterThanOrEqual(2);
  });

  it("leaves cards unchanged but records the attempts", () => {
    const b = new Builder();
    const base = b.session(DAY1, 1, "n1", 3, { introduce: true });
    const before = fold(base);
    const after = fold([...base, ...b.session(DAY2, 2, "n1", 6, { practice: true })]);
    expect(after.cards).toStrictEqual(before.cards);
    expect(after.cards["n1:0"]?.reps).toBe(1);
    expect(after.attempts.n1).toHaveLength(9);
    expect(after.sessions[b.sessionId(2)]?.practice).toBe(true);
    expect(after.sessions[b.sessionId(1)]?.practice).toBeUndefined();
    expect(after.daily["2026-01-02"]?.sessions).toBe(1);
  });

  it("does not create a card for an item first seen in practice", () => {
    const b = new Builder();
    const s = fold([...b.session(DAY1, 1, "n1", 1, { introduce: true, practice: true })]);
    expect(s.cards).toEqual({});
    expect(s.attempts.n1).toHaveLength(1);
  });

  it("counts toward mastery windows exactly like a normal session", () => {
    const b1 = new Builder();
    const b2 = new Builder();
    const day1 = (b: Builder) => b.session(DAY1, 1, "n1", 3, { introduce: true });
    const normal = fold([...day1(b1), ...b1.session(DAY2, 2, "n1", 3)]);
    const practice = fold([...day1(b2), ...b2.session(DAY2, 2, "n1", 3, { practice: true })]);
    expect(normal.nodes.n1?.state).toBe("mastered");
    expect(practice.nodes.n1?.state).toBe("mastered");
    expect(practice.attempts).toStrictEqual(normal.attempts);
    expect(practice.durations).toStrictEqual(normal.durations);
    expect(practice.nodes).toStrictEqual(normal.nodes);
  });

  it("folds newItemsPerDay into settings", () => {
    const b = new Builder();
    const s = fold([
      b.settings(T0 + 1, { newItemsPerDay: 9 }),
      b.settings(T0 + 2, { budgetSec: 300 }),
    ]);
    expect(s.settings).toEqual({ newItemsPerDay: 9, budgetSec: 300 });
  });

  const practiceFlags = fc.array(fc.boolean(), { minLength: 2, maxLength: 5 });

  it("property: refold is order independent with practice sessions", () => {
    fc.assert(
      fc.property(
        practiceFlags,
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 40 }),
        (flags, keys) => {
          const b = new Builder();
          const events = flags.flatMap((practice, i) =>
            b.session(T0 + i * DAY_MS + 6 * 3_600_000, i, "n1", 3, {
              introduce: i === 0,
              practice: practice && i > 0,
            }),
          );
          expect(fold(shuffled(events, keys))).toStrictEqual(fold([...events].sort(compareEvents)));
        },
      ),
      { numRuns: 60 },
    );
  });

  it("property: cards equal the fold of the non-practice sessions alone, and replay is idempotent", () => {
    fc.assert(
      fc.property(practiceFlags, (flags) => {
        const b = new Builder();
        const sessions = flags.map((practice, i) => ({
          practice: practice && i > 0,
          events: b.session(T0 + i * DAY_MS + 6 * 3_600_000, i, "n1", 3, {
            introduce: i === 0,
            practice: practice && i > 0,
          }),
        }));
        const all = sessions.flatMap((s) => s.events);
        const normalOnly = sessions.filter((s) => !s.practice).flatMap((s) => s.events);
        expect(fold(all).cards).toStrictEqual(fold(normalOnly).cards);
        expect(fold([...all, ...all])).toStrictEqual(fold(all));
      }),
      { numRuns: 60 },
    );
  });
});

describe("LearnerStateService", () => {
  const history = (): LearningEvent[] => {
    const b = new Builder();
    return [
      ...b.session(T0 + 3_600_000, 1, "n1", 4, { introduce: true }),
      ...b.session(T0 + DAY_MS + 3_600_000, 2, "n1", 4),
    ];
  };

  it("loads from an empty store", async () => {
    const svc = new LearnerStateService({ store: new MemoryEventStore(), ctx: C });
    expect(await svc.load()).toStrictEqual(fold([]));
  });

  it("applies in-order appends incrementally and out-of-order appends by refold", async () => {
    const events = history().sort(compareEvents);
    const store = new MemoryEventStore();
    const svc = new LearnerStateService({ store, ctx: C, snapshotEvery: 5 });
    await svc.load();
    const half = Math.floor(events.length / 2);
    await svc.append(events.slice(half));
    expect(svc.state).toStrictEqual(fold(events.slice(half)));
    // Older events arrive afterwards (a sync merge): must refold.
    await svc.append(events.slice(0, half));
    expect(svc.state).toStrictEqual(fold(events));
    // Re-appending known events changes nothing.
    await svc.append(events.slice(0, 3));
    expect(svc.state).toStrictEqual(fold(events));
  });

  it("writes snapshots every N events and reloads from them", async () => {
    const events = history().sort(compareEvents);
    const store = new MemoryEventStore();
    const svc = new LearnerStateService({ store, ctx: C, snapshotEvery: 7 });
    await svc.load();
    for (const e of events) await svc.append([e]);
    const snap = await store.getSnapshot("learner");
    expect(snap).toBeDefined();
    expect(snap?.reducerVersion).toBe(REDUCER_VERSION);
    const fresh = new LearnerStateService({ store, ctx: C, snapshotEvery: 7 });
    expect(await fresh.load()).toStrictEqual(fold(events));
  });

  it("picks up a tail written after the snapshot", async () => {
    const events = history().sort(compareEvents);
    const store = new MemoryEventStore();
    await store.append(events.slice(0, 10));
    await store.putSnapshot(makeSnapshot(fold(events.slice(0, 10)), C.graph.contentVersion));
    await store.append(events.slice(10));
    const svc = new LearnerStateService({ store, ctx: C });
    expect(await svc.load()).toStrictEqual(fold(events));
  });

  it("ignores a stale snapshot (reducer or content version)", async () => {
    const events = history().sort(compareEvents);
    const bogus = fold(events.slice(0, 4));
    bogus.eventCount = 9999;
    for (const patch of [{ reducerVersion: REDUCER_VERSION + 1 }, { contentVersion: "old" }]) {
      const store = new MemoryEventStore();
      await store.append(events);
      const snap = { ...makeSnapshot(bogus, C.graph.contentVersion), ...patch };
      await store.putSnapshot(snap);
      expect(restoreSnapshot(snap, C.graph.contentVersion)).toBeUndefined();
      const svc = new LearnerStateService({ store, ctx: C });
      expect(await svc.load()).toStrictEqual(fold(events));
    }
  });

  it("falls back to a full fold when the snapshot cursor is unknown", async () => {
    const events = history().sort(compareEvents);
    const store = new MemoryEventStore();
    await store.append(events.slice(0, 5));
    await store.putSnapshot(makeSnapshot(fold(events), C.graph.contentVersion));
    const svc = new LearnerStateService({ store, ctx: C });
    expect(await svc.load()).toStrictEqual(fold(events.slice(0, 5)));
  });

  it("throws on state access before load", () => {
    const svc = new LearnerStateService({ store: new MemoryEventStore(), ctx: C });
    expect(() => svc.state).toThrow();
  });
});

/* ---------- examples ---------- */

describe("node lifecycle", () => {
  it("starts with roots available and dependents locked", () => {
    const s = fold([]);
    expect(s.nodes.n1?.state).toBe("available");
    expect(s.nodes.n2?.state).toBe("locked");
    expect(s.nodes.n4?.state).toBe("locked");
  });

  it("introduction makes a node learning and is counted once", () => {
    const b = new Builder();
    const sid = b.sessionId(1);
    const evs = [
      b.start(T0 + 1000, sid),
      b.introduce(T0 + 2000, sid, "n1"),
      b.introduce(T0 + 3000, sid, "n1"),
      b.introduce(T0 + 4000, sid, "n2"), // locked: ignored
    ];
    const s = fold(evs);
    expect(s.nodes.n1).toMatchObject({ state: "learning", introducedAt: T0 + 2000 });
    expect(s.nodes.n2?.state).toBe("locked");
    expect(s.daily["2025-12-31"]?.nodesIntroduced).toBe(1);
    expect(s.warnings).toBe(1);
  });

  it("perfect instrument history over two days masters a node and unlocks dependents", () => {
    const b = new Builder();
    const evs = [
      ...b.session(T0 + 6 * 3_600_000, 1, "n1", 3, { introduce: true }),
      ...b.session(T0 + DAY_MS + 6 * 3_600_000, 2, "n1", 3),
    ];
    const s = fold(evs);
    expect(s.nodes.n1?.state).toBe("mastered");
    expect(s.nodes.n2?.state).toBe("available");
    expect(s.nodes.n3?.state).toBe("available");
    expect(s.nodes.n4?.state).toBe("locked"); // no implemented generator
    expect(s.nodes.n5?.state).toBe("locked"); // soft prereq n2 not yet learning
    expect(Object.keys(s.cards)).toHaveLength(3);
    expect(s.cards["n1:0"]?.reps).toBe(2);
    expect(s.attempts.n1).toHaveLength(6);
  });

  it("soft prerequisite unlocks once the prerequisite is learning", () => {
    const b = new Builder();
    const sid = b.sessionId(1);
    const s = fold([
      b.place(T0, { n1: "mastered" }),
      b.start(T0 + 1000, sid),
      b.introduce(T0 + 2000, sid, "n2"),
    ]);
    expect(s.nodes.n2?.state).toBe("learning");
    expect(s.nodes.n5?.state).toBe("available");
  });

  it("away-only history reaches fluent but not mastered", () => {
    const b = new Builder();
    const evs = [
      ...b.session(T0 + 6 * 3_600_000, 1, "n1", 3, { introduce: true, mode: "away" }),
      ...b.session(T0 + DAY_MS + 6 * 3_600_000, 2, "n1", 3, { mode: "away" }),
      ...b.session(T0 + 2 * DAY_MS + 6 * 3_600_000, 3, "n1", 3, { mode: "away" }),
    ];
    const s = fold(evs);
    expect(s.nodes.n1?.state).toBe("fluent");
    expect(s.nodes.n2?.state).toBe("locked");
  });

  it("placement sets a floor that poor performance can demote, without relocking dependents", () => {
    const b = new Builder();
    const sid = b.sessionId(9);
    const evs = [
      b.place(T0, { n1: "mastered" }),
      b.start(T0 + 1000, sid),
      b.introduce(T0 + 2000, sid, "n2"),
    ];
    let s = fold(evs);
    expect(s.nodes.n1).toMatchObject({ state: "mastered", placementFloor: "mastered" });
    expect(s.nodes.n2?.state).toBe("learning");

    const poor = b.session(T0 + 3_600_000, 1, "n1", 4, { correct: false });
    s = fold([...evs, ...poor]);
    expect(s.nodes.n1?.state).toBe("fluent");
    expect(s.nodes.n1?.placementFloor).toBe("mastered");
    expect(s.nodes.n2?.state).toBe("learning"); // progress kept
  });

  it("placement available does not bypass an unimplemented generator", () => {
    const b = new Builder();
    const s = fold([b.place(T0, { n4: "available", n2: "available" })]);
    expect(s.nodes.n4?.state).toBe("locked");
    expect(s.nodes.n2?.state).toBe("available");
  });

  it("evaluates key-dependent nodes per family and combines them", () => {
    const b = new Builder();
    const place = b.place(T0, { n1: "mastered" });
    const sid0 = b.sessionId(0);
    const intro = [b.start(T0 + 1000, sid0), b.introduce(T0 + 2000, sid0, "n3", "A")];
    const famA = [
      ...b.session(T0 + DAY_MS + 6 * 3_600_000, 1, "n3", 3, { key: KEY_C }),
      ...b.session(T0 + 2 * DAY_MS + 6 * 3_600_000, 2, "n3", 3, { key: KEY_C }),
    ];
    let s = fold([place, ...intro, ...famA]);
    expect(s.nodes.n3?.byFamily).toEqual({ A: "mastered" });
    expect(s.nodes.n3?.state).toBe("fluent"); // A mastered, B not yet fluent
    expect(s.attempts.n3?.every((a) => a.keyFamily === "A")).toBe(true);

    const famB = [
      ...b.session(T0 + 3 * DAY_MS + 6 * 3_600_000, 3, "n3", 3, { key: KEY_D }),
      ...b.session(T0 + 4 * DAY_MS + 6 * 3_600_000, 4, "n3", 3, { key: KEY_D }),
    ];
    s = fold([place, ...intro, ...famA, ...famB]);
    expect(s.nodes.n3?.byFamily).toMatchObject({ A: "mastered", B: "mastered" });
    expect(s.nodes.n3?.state).toBe("mastered");
  });

  it("uses the presentation tonic for the key family when present", () => {
    const b = new Builder();
    const sid = b.sessionId(1);
    const s = fold([
      b.place(T0, { n1: "mastered" }),
      b.start(T0 + 1000, sid, { key: KEY_C }),
      b.introduce(T0 + 2000, sid, "n3"),
      ...b.item(T0 + 3000, sid, "n3", "n3:0", { presentation: { tonic: "E", mode: "major" } }),
    ]);
    expect(s.attempts.n3?.[0]?.keyFamily).toBe("C");
  });
});

describe("event handling", () => {
  it("skips FSRS and grading for an attempt with no session or presentation", () => {
    const b = new Builder();
    const sid = b.sessionId(1);
    const orphanItem = b.item(T0 + 3000, sid, "n1", "n1:0");
    // No session.started at all.
    let s = fold(orphanItem);
    expect(s.warnings).toBeGreaterThan(0);
    expect(s.cards).toEqual({});
    expect(s.attempts).toEqual({});
    // Session but no presentation.
    s = fold([b.start(T0 + 1000, sid), ...orphanItem.slice(1)]);
    expect(s.warnings).toBe(1);
    expect(s.cards).toEqual({});
    expect(s.eventCount).toBe(2);
  });

  it("tracks sessions, daily totals, practice time cap and key of the day", () => {
    const b = new Builder();
    const s1 = b.sessionId(1);
    const s2 = b.sessionId(2);
    const at = T0 + 6 * 3_600_000;
    const s = fold([
      b.start(at, s1, { budgetSec: 60, key: KEY_D }),
      ...b.item(at + 1000, s1, "n1", "n1:0", { isNew: true }),
      ...b.item(at + 9000, s1, "n1", "n1:1", { isNew: true }),
      b.end(at + 10 * 60_000, s1), // way over 2x budget
      b.start(at + 3_600_000, s2, { mode: "away", key: KEY_C }),
      b.end(at + 3_600_000 + 30_000, s2),
    ]);
    const day = s.daily["2026-01-01"];
    expect(day).toMatchObject({ newItems: 2, sessions: 2, practiceSec: 120 + 30 });
    expect(day?.mode).toEqual({ instrument: 1, away: 1 });
    expect(s.sessions[s1]).toMatchObject({ itemsPresented: 2, endedAt: at + 600_000 });
    expect(s.keyOfDayHistory).toEqual([{ day: "2026-01-01", key: KEY_D }]);
    expect(s.presented).toEqual({});
  });

  it("uses the session's timezone and 04:00 rollover for the learner day", () => {
    const b = new Builder();
    const sid = b.sessionId(1);
    // 2026-01-01T20:00Z at +600 is 06:00 on Jan 2 local.
    const s = fold([b.start(T0 + 20 * 3_600_000, sid, { tz: 600 })]);
    expect(Object.keys(s.daily)).toEqual(["2026-01-02"]);
  });

  it("merges settings patches", () => {
    const b = new Builder();
    const s = fold([
      b.settings(T0 + 1, { budgetSec: 300 }),
      b.settings(T0 + 2, { headphones: true }),
      b.settings(T0 + 3, { budgetSec: 900 }),
      b.register(T0 + 4),
    ]);
    expect(s.settings).toEqual({ budgetSec: 900, headphones: true });
    expect(s.eventCount).toBe(4);
  });

  it("ignores unknown future event types", () => {
    const b = new Builder();
    const future = {
      ...b.register(T0 + 5),
      type: "future.thing",
      v: 7,
    } as unknown as LearningEvent;
    const s = fold([future]);
    expect(s.eventCount).toBe(1);
    expect(s.lastEvent?.id).toBe(future.id);
    expect(s.warnings).toBe(0);
  });

  it("records durations and exposes a rolling median with a graph seed", () => {
    const b = new Builder();
    const sid = b.sessionId(1);
    const evs: LearningEvent[] = [b.start(T0, sid)];
    let t = T0 + 1000;
    for (let i = 0; i < 25; i++) {
      evs.push(...b.item(t, sid, "n1", `n1:${String(i % 3)}`, { latencyMs: (i + 1) * 100 }));
      t += 10_000;
    }
    const s = fold(evs);
    expect(s.durations.degreeId).toHaveLength(20);
    // Last 20 durations are 0.6 .. 2.5 seconds, median 1.55.
    expect(medianDurationSec(s, "degreeId", 99)).toBeCloseTo(1.55);
    expect(medianDurationSec(s, "cellEcho", 12)).toBe(12);
    expect(medianDurationSec(fold(evs.slice(0, 3)), "degreeId", 12)).toBe(12);
  });

  it("does not mutate its input state", () => {
    const b = new Builder();
    const base = fold([]);
    const frozen = JSON.stringify(base);
    applyEvent(base, b.register(T0), C);
    expect(JSON.stringify(base)).toBe(frozen);
  });

  it("has the fixture graph it claims", () => {
    expect(FIXTURE_GRAPH.nodes).toHaveLength(5);
  });
});
