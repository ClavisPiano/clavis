import { MemoryEventStore } from "@clavis/core";
import { describe, expect, it, vi } from "vitest";
import { createAppStoreInitializer, detectPlatform } from "./app-store";

const base = {
  now: () => 1_700_000_000_000,
  randomBytes: (n: number) => new Uint8Array(n).fill(7),
  platform: "TestOS",
};

describe("createAppStoreInitializer", () => {
  it("registers the device once and memoizes the result", async () => {
    const store = new MemoryEventStore();
    const createStore = vi.fn(() => store);
    const init = createAppStoreInitializer({ ...base, createStore });
    const [a, b] = await Promise.all([init(), init()]);
    expect(a).toBe(b);
    expect(createStore).toHaveBeenCalledTimes(1);
    expect(a.ok && a.deviceId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(await store.list()).toHaveLength(1);
  });

  it("is idempotent across initializers sharing a store", async () => {
    const store = new MemoryEventStore();
    const first = await createAppStoreInitializer({ ...base, createStore: () => store })();
    const second = await createAppStoreInitializer({ ...base, createStore: () => store })();
    expect(first.ok && second.ok && first.deviceId === second.deviceId).toBe(true);
    expect(await store.list()).toHaveLength(1);
  });

  it("resolves to ok:false and logs when the store fails", async () => {
    const failure = new Error("IndexedDB blocked");
    const logError = vi.fn();
    const init = createAppStoreInitializer({
      ...base,
      logError,
      createStore: () => {
        throw failure;
      },
    });
    await expect(init()).resolves.toEqual({ ok: false, error: failure });
    expect(logError).toHaveBeenCalledWith(expect.any(String), failure);
  });

  it("resolves to ok:false when registration rejects", async () => {
    const store = new MemoryEventStore();
    store.getMeta = () => Promise.reject(new Error("quota"));
    const result = await createAppStoreInitializer({
      ...base,
      logError: () => undefined,
      createStore: () => store,
    })();
    expect(result.ok).toBe(false);
  });
});

describe("detectPlatform", () => {
  it.each([
    [{ userAgentData: { platform: "macOS" }, platform: "MacIntel" }, "macOS"],
    [{ platform: "iPhone" }, "iPhone"],
    [{ userAgentData: {} }, "unknown"],
    [{}, "unknown"],
  ] as const)("%j -> %s", (nav, expected) => {
    expect(detectPlatform(nav)).toBe(expected);
  });
});
