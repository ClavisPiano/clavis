import { describe, expect, it } from "vitest";
import {
  CLOCK_JUMP_BACK_MS,
  MAX_AHEAD_MS,
  SKEW_KEY,
  correctedNow,
  observeServerDate,
  readSkew,
} from "./clock";

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
    expect(readSkew(store, SERVER + 6000)).toBe(-5000);
  });

  it("drops a stored skew once the device clock has been set back past the observation", () => {
    const store = memory();
    const ahead = SERVER + 2 * MAX_AHEAD_MS;
    observeServerDate(new Date(SERVER).toUTCString(), ahead, store);
    expect(readSkew(store, ahead + 1000)).toBe(SERVER - ahead);
    // The person fixes the clock: it now reads the real time, days before the observation.
    expect(readSkew(store, SERVER)).toBe(0);
    expect(correctedNow(SERVER, readSkew(store, SERVER))).toBe(SERVER);
  });

  it("tolerates a small step back, and keeps a skew with no recorded observation time", () => {
    const store = memory();
    observeServerDate(new Date(SERVER).toUTCString(), SERVER + 3 * MAX_AHEAD_MS, store);
    const at = SERVER + 3 * MAX_AHEAD_MS;
    expect(readSkew(store, at - CLOCK_JUMP_BACK_MS + 1)).toBe(-3 * MAX_AHEAD_MS);
    expect(readSkew(store, at - CLOCK_JUMP_BACK_MS - 1)).toBe(0);
    const old = memory({ [SKEW_KEY]: "-99" });
    expect(readSkew(old, 0)).toBe(-99);
  });

  it("ignores a missing or unparseable header", () => {
    const store = memory({ [SKEW_KEY]: "123" });
    observeServerDate(null, SERVER, store);
    observeServerDate("not a date", SERVER, store);
    expect(readSkew(store, SERVER)).toBe(123);
  });

  it("does not leave a skew without an observation time when the second write fails", () => {
    const base = memory();
    const flaky = {
      ...base,
      setItem: (k: string, v: string) => {
        if (k !== SKEW_KEY) throw new Error("quota");
        base.setItem(k, v);
      },
    };
    observeServerDate(new Date(SERVER).toUTCString(), SERVER + 5000, flaky);
    expect(base.getItem(SKEW_KEY)).toBeNull();
    expect(readSkew(base, SERVER)).toBe(0);
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
