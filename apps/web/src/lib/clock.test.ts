import { describe, expect, it } from "vitest";
import { MAX_AHEAD_MS, SKEW_KEY, correctedNow, observeServerDate, readSkew } from "./clock";

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

const SERVER = Date.UTC(2026, 9, 18, 10, 0, 0);

describe("correctedNow", () => {
  it.each([
    ["no skew known", 0],
    ["a small drift ahead", -5 * 60_000],
    ["a small drift behind", 5 * 60_000],
    ["a clock days behind the server", 3 * 86_400_000],
    ["exactly a day ahead", -MAX_AHEAD_MS],
  ])("leaves the device time alone for %s", (_name, skew) => {
    expect(correctedNow(SERVER, skew)).toBe(SERVER);
  });

  it("pulls a clock that is years ahead back to the server's time", () => {
    const device = SERVER + 3 * 365 * 86_400_000;
    expect(correctedNow(device, SERVER - device)).toBe(SERVER);
  });

  it("corrects a clock one day and a minute ahead", () => {
    const device = SERVER + MAX_AHEAD_MS + 60_000;
    expect(correctedNow(device, SERVER - device)).toBe(SERVER);
  });
});

describe("observeServerDate", () => {
  it("stores server minus device time from a Date header", () => {
    const store = memory();
    observeServerDate(new Date(SERVER).toUTCString(), SERVER + 5000, store);
    expect(readSkew(store)).toBe(-5000);
  });

  it("ignores a missing or unparseable header", () => {
    const store = memory({ [SKEW_KEY]: "123" });
    observeServerDate(null, SERVER, store);
    observeServerDate("not a date", SERVER, store);
    expect(readSkew(store)).toBe(123);
  });

  it("survives blocked storage", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => {
      observeServerDate(new Date(SERVER).toUTCString(), SERVER, blocked);
    }).not.toThrow();
    expect(readSkew(blocked)).toBe(0);
    expect(readSkew(undefined)).toBe(0);
  });
});
