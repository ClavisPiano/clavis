import { loadGraph } from "@clavis/content";
import {
  LearnerStateService,
  MemoryEventStore,
  createScheduler,
  encodeTime,
  type LearningEvent,
} from "@clavis/core";
import { describe, expect, it } from "vitest";
import {
  buildExport,
  exportFilename,
  runImport,
  validateImport,
  validateImportText,
} from "./backup";
import { dueRows, durationRows, nodeRows, recentDays } from "./state-view";

const DAY = 86_400_000;
const T0 = 1_767_225_600_000 + 6 * 3_600_000; // 2026-01-01 06:00Z
const DEVICE = "dev-a";
const NODE = "ear.degrees.major.135";
const graph = loadGraph();

let seq = 0;
const base = (at: number) => {
  seq++;
  return { id: encodeTime(at) + "A" + String(seq).padStart(15, "0"), deviceId: DEVICE, at };
};
const sid = (n: number) => encodeTime(T0) + "S" + String(n).padStart(15, "0");

function stream(): LearningEvent[] {
  seq = 0;
  const out: LearningEvent[] = [
    { ...base(T0 - 1000), type: "device.registered", v: 1, platform: "test" },
  ];
  for (const [n, start] of [
    [1, T0],
    [2, T0 + DAY],
  ] as const) {
    const s = sid(n);
    out.push({
      ...base(start),
      type: "session.started",
      v: 2,
      sessionId: s,
      mode: "instrument",
      budgetSec: 600,
      key: { tonic: "C", mode: "major" },
      tzOffsetMin: 0,
      contentVersion: graph.contentVersion,
    });
    if (n === 1) {
      out.push({
        ...base(start + 500),
        type: "node.introduced",
        v: 1,
        sessionId: s,
        nodeId: NODE,
      });
    }
    for (let i = 0; i < 4; i++) {
      const at = start + 1000 + i * 5000;
      const itemId = `item-${String(i % 2)}`;
      out.push(
        {
          ...base(at),
          type: "item.presented",
          v: 1,
          sessionId: s,
          itemId,
          nodeId: NODE,
          generator: "degreeId",
          block: "ear",
          isNew: n === 1 && i < 2,
          presentation: {},
        },
        {
          ...base(at + 1500),
          type: "attempt.completed",
          v: 2,
          sessionId: s,
          itemId,
          nodeId: NODE,
          outcome: { correct: i !== 3, latencyMs: 1500, retries: 0 },
          inputSource: "midi",
        },
      );
    }
    out.push({
      ...base(start + 60_000),
      type: "session.ended",
      v: 1,
      sessionId: s,
      reason: "completed",
    });
  }
  return out;
}

function setup(store = new MemoryEventStore()) {
  const service = new LearnerStateService({
    store,
    ctx: { graph, scheduler: createScheduler() },
  });
  return { store, service };
}

async function seeded() {
  const { store, service } = setup();
  await service.load();
  await service.append(stream());
  return { store, service };
}

const exportOf = async (store: MemoryEventStore) =>
  buildExport({
    events: await store.list(),
    deviceId: DEVICE,
    contentVersion: graph.contentVersion,
    now: new Date(Date.UTC(2026, 0, 3, 9, 5)),
  });

describe("export document", () => {
  it("has the documented envelope and sorted events", async () => {
    const { store } = await seeded();
    const doc = await exportOf(store);
    expect(doc).toMatchObject({
      format: "clavis-events",
      formatVersion: 1,
      exportedAt: "2026-01-03T09:05:00.000Z",
      deviceId: DEVICE,
      contentVersion: graph.contentVersion,
    });
    expect(typeof doc.reducerVersion).toBe("number");
    expect(doc.events).toHaveLength(stream().length);
    const ats = doc.events.map((e) => e.at);
    expect(ats).toEqual([...ats].sort((a, b) => a - b));
  });

  it("names the file with a UTC timestamp", () => {
    expect(exportFilename("DEV", new Date(Date.UTC(2026, 0, 3, 9, 5)))).toBe(
      "clavis-events-DEV-20260103-0905.json",
    );
  });
});

describe("export -> wipe -> import", () => {
  it("reproduces identical state", async () => {
    const { store, service } = await seeded();
    const before = structuredClone(service.state);
    const text = JSON.stringify(await exportOf(store));

    await store.clear();
    const fresh = setup(store);
    await fresh.service.load();
    expect(fresh.service.state.eventCount).toBe(0);

    const v = validateImportText(text);
    if (!v.ok) throw new Error("expected valid");
    const result = await runImport(fresh.service, store, v.events, "merge", 3);
    expect(result.inserted).toBe(before.eventCount);
    expect(result.skipped).toBe(0);
    expect(fresh.service.state).toEqual(before);

    // A cold load from the store agrees too.
    const cold = setup(store);
    await cold.service.load();
    expect(cold.service.state).toEqual(before);
  });

  it("importing the same file twice inserts nothing the second time", async () => {
    const { store, service } = await seeded();
    const v = validateImport(await exportOf(store));
    if (!v.ok) throw new Error("expected valid");
    const before = structuredClone(service.state);
    const result = await runImport(service, store, v.events, "merge");
    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(v.events.length);
    expect(service.state).toEqual(before);
    expect(await store.list()).toHaveLength(before.eventCount);
  });

  it("replace deletes existing events, keeps the device id and refolds", async () => {
    const { store, service } = await seeded();
    await store.setMeta("deviceId", "keep-me");
    const all = stream();
    const subset = all.slice(0, 5);
    const result = await runImport(service, store, subset, "replace");
    expect(result.deleted).toBe(all.length);
    expect(result.inserted).toBe(5);
    expect(await store.list()).toHaveLength(5);
    expect(await store.getMeta("deviceId")).toBe("keep-me");
    expect(service.state.eventCount).toBe(5);
  });

  it("merge of older events into a newer log refolds to the full state", async () => {
    const { store, service } = await seeded();
    const expected = structuredClone(service.state);
    const events = stream();
    const half = setup();
    await half.service.load();
    await half.service.append(events.filter((e) => e.at >= T0 + DAY - 1));
    const v = validateImport(await exportOf(store));
    if (!v.ok) throw new Error("expected valid");
    await runImport(half.service, half.store, v.events, "merge", 4);
    expect(half.service.state).toEqual(expected);
  });
});

describe("validation", () => {
  it("rejects bad envelopes", () => {
    for (const doc of [
      null,
      [],
      { format: "other", formatVersion: 1, events: [] },
      { format: "clavis-events", formatVersion: 2, events: [] },
      { format: "clavis-events", formatVersion: 1, events: {} },
    ]) {
      const v = validateImport(doc);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.errors[0]?.index).toBe(-1);
    }
    expect(validateImportText("{nope").ok).toBe(false);
  });

  it("collects errors with indexes and imports nothing", async () => {
    const { store, service } = setup();
    await service.load();
    const events = stream();
    const doc = {
      format: "clavis-events",
      formatVersion: 1,
      events: [events[0], { ...events[1], type: "bogus" }, events[2], { nope: true }],
    };
    const v = validateImport(doc);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.map((e) => e.index)).toEqual([1, 3]);
    // The caller never reaches runImport on failure: nothing was written.
    expect(await store.list()).toHaveLength(0);
  });
});

describe("state view", () => {
  it("derives node, due, daily and duration rows", async () => {
    const { service } = await seeded();
    const state = service.state;
    const rows = nodeRows(state, graph);
    expect(rows).toHaveLength(graph.nodes.length);
    const row = rows.find((r) => r.id === NODE);
    expect(row?.attempts).toBe(8);
    expect(row?.introducedAt).toBeDefined();
    const now = T0 + 30 * DAY;
    const due = dueRows(state, now);
    expect(due.length).toBeGreaterThan(0);
    expect(due[0]?.nodeId).toBe(NODE);
    const days = recentDays(state, T0 + DAY, 0);
    expect(days).toHaveLength(7);
    expect(days[0]?.record.sessions).toBe(1);
    expect(durationRows(state, graph).find((d) => d.generator === "degreeId")?.samples).toBe(8);
  });
});
