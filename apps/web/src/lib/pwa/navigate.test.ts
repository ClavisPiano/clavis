import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NAVIGATE_TIMEOUT_MS, networkFirst } from "./navigate";

describe("networkFirst", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the network response when it answers in time", async () => {
    const p = networkFirst(
      () => Promise.resolve("net"),
      () => Promise.resolve("cache"),
    );
    await expect(p).resolves.toBe("net");
  });

  it("uses the fallback when the network rejects", async () => {
    const p = networkFirst(
      () => Promise.reject(new TypeError("offline")),
      () => Promise.resolve("cache"),
    );
    await expect(p).resolves.toBe("cache");
  });

  it("uses the fallback when the network is slower than the deadline", async () => {
    const p = networkFirst(
      () => new Promise<string>(() => undefined),
      () => Promise.resolve("cache"),
    );
    await vi.advanceTimersByTimeAsync(NAVIGATE_TIMEOUT_MS);
    await expect(p).resolves.toBe("cache");
  });

  it("does not time out a response that arrives just before the deadline", async () => {
    const p = networkFirst(
      () =>
        new Promise<string>((r) =>
          setTimeout(() => {
            r("net");
          }, 2900),
        ),
      () => Promise.resolve("cache"),
    );
    await vi.advanceTimersByTimeAsync(3000);
    await expect(p).resolves.toBe("net");
  });
});
