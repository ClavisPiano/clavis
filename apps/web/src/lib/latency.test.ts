import { MemoryEventStore } from "@clavis/core";
import { describe, expect, it } from "vitest";
import {
  LATENCY_META_KEY,
  parseLatencyMeta,
  readLatency,
  resetLatency,
  saveLatency,
  toOffsets,
} from "./latency";

const deps = (t: number) => ({ now: () => t, userAgent: "UA" });

describe("latency meta", () => {
  it("reads nothing from an empty store", async () => {
    expect(await readLatency(new MemoryEventStore())).toBeUndefined();
  });

  it("saves under the shared key with the documented shape", async () => {
    const store = new MemoryEventStore();
    const saved = await saveLatency(store, { tapMs: 95.5 }, deps(1000));
    expect(saved).toEqual({ tapMs: 95.5, measuredAt: 1000, userAgent: "UA" });
    expect(await store.getMeta(LATENCY_META_KEY)).toEqual(saved);
  });

  it("merges a new path over the saved one", async () => {
    const store = new MemoryEventStore();
    await saveLatency(store, { tapMs: 90, micMs: 150 }, deps(1));
    await saveLatency(store, { tapMs: 80 }, deps(2));
    expect(await readLatency(store)).toEqual({
      tapMs: 80,
      micMs: 150,
      measuredAt: 2,
      userAgent: "UA",
    });
  });

  it("reset clears the offsets", async () => {
    const store = new MemoryEventStore();
    await saveLatency(store, { tapMs: 90 }, deps(1));
    await resetLatency(store);
    expect(await readLatency(store)).toBeUndefined();
    expect(toOffsets(await readLatency(store))).toEqual({});
  });

  it("rejects malformed stored values", () => {
    expect(parseLatencyMeta("x")).toBeUndefined();
    expect(parseLatencyMeta({ tapMs: 1 })).toBeUndefined();
    expect(parseLatencyMeta({ tapMs: "1", measuredAt: 1, userAgent: "u" })).toEqual({
      measuredAt: 1,
      userAgent: "u",
    });
  });
});
