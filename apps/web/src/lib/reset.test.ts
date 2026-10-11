import { DEVICE_ID_META_KEY, MemoryEventStore, encodeTime, type LearningEvent } from "@clavis/core";
import { describe, expect, it } from "vitest";
import { DEV_TOOLS_STORAGE_KEY } from "./dev-tools";
import { PLACEMENT_SKIPPED_META_KEY } from "./placement";
import { resetEverything, resetProgress } from "./reset";
import { HEADPHONES_META_KEY, ORIENT_CARD_META_KEY } from "./session/runtime";
import { LATENCY_META_KEY } from "./latency";

const T0 = 1_767_225_600_000;
const DEVICE = "dev-a";
let seq = 0;
const base = (at: number) => {
  seq++;
  return { id: encodeTime(at) + "A" + String(seq).padStart(15, "0"), deviceId: DEVICE, at };
};

function stream(): LearningEvent[] {
  seq = 0;
  const sessionId = encodeTime(T0) + "S" + "0".repeat(15);
  return [
    { ...base(T0), type: "device.registered", v: 1, platform: "test" },
    { ...base(T0 + 1), type: "settings.changed", v: 2, patch: { newItemsPerDay: 5 } },
    {
      ...base(T0 + 2),
      type: "session.started",
      v: 2,
      sessionId,
      mode: "instrument",
      budgetSec: 600,
      key: { tonic: "C", mode: "major" },
      tzOffsetMin: 0,
      contentVersion: "test",
    },
    {
      ...base(T0 + 3),
      type: "node.introduced",
      v: 1,
      sessionId,
      nodeId: "ear.degrees.major.135",
    },
    { ...base(T0 + 4), type: "session.ended", v: 1, sessionId, reason: "completed" },
  ];
}

async function seeded(): Promise<MemoryEventStore> {
  const store = new MemoryEventStore();
  await store.append(stream());
  await store.setMeta(DEVICE_ID_META_KEY, DEVICE);
  await store.setMeta(LATENCY_META_KEY, { offsetMs: 42 });
  await store.setMeta(HEADPHONES_META_KEY, true);
  await store.setMeta(PLACEMENT_SKIPPED_META_KEY, true);
  await store.setMeta(ORIENT_CARD_META_KEY, true);
  return store;
}

function memoryLocal(entries: Record<string, string>) {
  const m = new Map(Object.entries(entries));
  return {
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => void m.delete(k),
    keys: () => [...m.keys()],
  };
}

describe("resetProgress", () => {
  it("keeps setup events and device meta, drops learning and progress meta", async () => {
    const store = await seeded();
    const result = await resetProgress(store);
    expect(result).toEqual({ kept: 2, removed: 3 });
    expect((await store.list()).map((e) => e.type)).toEqual([
      "device.registered",
      "settings.changed",
    ]);
    expect(await store.getMeta(DEVICE_ID_META_KEY)).toBe(DEVICE);
    expect(await store.getMeta(LATENCY_META_KEY)).toEqual({ offsetMs: 42 });
    expect(await store.getMeta(HEADPHONES_META_KEY)).toBe(true);
    expect(await store.getMeta(PLACEMENT_SKIPPED_META_KEY)).toBeUndefined();
    expect(await store.getMeta(ORIENT_CARD_META_KEY)).toBeUndefined();
  });

  it("is a no-op on an empty store", async () => {
    const store = new MemoryEventStore();
    expect(await resetProgress(store)).toEqual({ kept: 0, removed: 0 });
    expect(await store.list()).toEqual([]);
  });
});

describe("resetEverything", () => {
  it("clears the store and app localStorage but keeps the dev tools switch", async () => {
    const store = await seeded();
    const local = memoryLocal({ clavisInput: "tap", [DEV_TOOLS_STORAGE_KEY]: "1" });
    await resetEverything(store, local);
    expect(await store.list()).toEqual([]);
    expect(await store.getMeta(DEVICE_ID_META_KEY)).toBeUndefined();
    expect(await store.getMeta(LATENCY_META_KEY)).toBeUndefined();
    expect(local.keys()).toEqual([DEV_TOOLS_STORAGE_KEY]);
  });
});
