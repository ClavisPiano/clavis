import { describe, expect, it } from "vitest";
import { describeEventStoreContract } from "../test-support.js";
import { getOrCreateDevice } from "./device.js";
import { MemoryEventStore } from "./memory-store.js";
import { createUlidGenerator } from "./ulid.js";

describeEventStoreContract("MemoryEventStore", () => Promise.resolve(new MemoryEventStore()));

describe("getOrCreateDevice", () => {
  function deps() {
    let counter = 0;
    const newId = createUlidGenerator({
      now: () => 1_700_000_000_000,
      randomBytes: (n) => new Uint8Array(n).fill(++counter),
    });
    return { newId, now: () => 1_700_000_000_123, platform: "test" };
  }

  it("creates once, registers an event, and is idempotent", async () => {
    const store = new MemoryEventStore();
    const d = deps();
    const first = await getOrCreateDevice(store, d);
    expect(first.created).toBe(true);
    const events = await store.list();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "device.registered",
      deviceId: first.deviceId,
      at: 1_700_000_000_123,
      platform: "test",
    });
    const second = await getOrCreateDevice(store, d);
    expect(second).toEqual({ deviceId: first.deviceId, created: false });
    expect(await store.list()).toHaveLength(1);
  });

  it("includes userAgent when given", async () => {
    const store = new MemoryEventStore();
    await getOrCreateDevice(store, { ...deps(), userAgent: "UA/1" });
    expect(await store.list()).toMatchObject([{ userAgent: "UA/1" }]);
  });
});
