import { describe, expect, it } from "vitest";
import {
  DEV_TOOLS_STORAGE_KEY,
  createTapCounter,
  devToolsEnabled,
  setDevToolsEnabled,
} from "./dev-tools";

function memoryStore(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

describe("dev tools toggle", () => {
  it("is off by default and round-trips", () => {
    const s = memoryStore();
    expect(devToolsEnabled(s)).toBe(false);
    setDevToolsEnabled(true, s);
    expect(s.getItem(DEV_TOOLS_STORAGE_KEY)).toBe("1");
    expect(devToolsEnabled(s)).toBe(true);
    setDevToolsEnabled(false, s);
    expect(devToolsEnabled(s)).toBe(false);
  });

  it("treats a throwing store as off", () => {
    const s = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => undefined,
    };
    expect(devToolsEnabled(s)).toBe(false);
    expect(() => {
      setDevToolsEnabled(true, s);
    }).not.toThrow();
  });
});

describe("createTapCounter", () => {
  it("fires on the seventh quick tap, then starts again", () => {
    const c = createTapCounter(7, 1000);
    const fired = [0, 100, 200, 300, 400, 500, 600].map((t) => c.tap(t));
    expect(fired).toEqual([false, false, false, false, false, false, true]);
    expect(c.tap(700)).toBe(false);
  });

  it("restarts the count after a slow tap", () => {
    const c = createTapCounter(3, 1000);
    expect(c.tap(0)).toBe(false);
    expect(c.tap(500)).toBe(false);
    expect(c.tap(2000)).toBe(false);
    expect(c.tap(2100)).toBe(false);
    expect(c.tap(2200)).toBe(true);
  });
});
