import { describe, expect, it } from "vitest";
import { createUlidGenerator, decodeTime, encodeTime, isUlid } from "./ulid.js";

const zeros = (n: number) => new Uint8Array(n);

describe("ulid", () => {
  it("matches the known vector for the spec timestamp", () => {
    // From the ULID spec: 1469918176385 ms encodes to 01ARYZ6S41.
    expect(encodeTime(1469918176385)).toBe("01ARYZ6S41");
    const gen = createUlidGenerator({ now: () => 1469918176385, randomBytes: zeros });
    expect(gen()).toBe("01ARYZ6S410000000000000000");
  });

  it("encodes random bytes in Crockford base32", () => {
    const gen = createUlidGenerator({
      now: () => 0,
      randomBytes: () => Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 31]),
    });
    expect(gen()).toBe("0000000000000000000Z".padStart(26, "0"));
    const max = createUlidGenerator({
      now: () => 2 ** 48 - 1,
      randomBytes: () => new Uint8Array(10).fill(255),
    });
    expect(max()).toBe("7ZZZZZZZZZZZZZZZZZZZZZZZZZ");
  });

  it("decodes the timestamp", () => {
    const gen = createUlidGenerator({
      now: () => 1_700_000_000_000,
      randomBytes: (n) => new Uint8Array(n).fill(7),
    });
    expect(decodeTime(gen())).toBe(1_700_000_000_000);
  });

  it("sorts lexicographically by time", () => {
    let t = 1_000;
    const gen = createUlidGenerator({
      now: () => t,
      randomBytes: (n) => new Uint8Array(n).fill(255 - (t % 200)),
    });
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      t += 1 + ((i * 7919) % 100_000);
      ids.push(gen());
    }
    expect([...ids].sort()).toEqual(ids);
  });

  it("is monotonic within the same millisecond, including carry", () => {
    const gen = createUlidGenerator({
      now: () => 5,
      randomBytes: () => Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 254]),
    });
    const ids = [gen(), gen(), gen()];
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]?.endsWith("7Y")).toBe(true);
    expect(ids[1]?.endsWith("7Z")).toBe(true);
    expect(ids[2]?.endsWith("80")).toBe(true);
  });

  it("stays monotonic if the clock steps backwards", () => {
    const times = [100, 99, 98];
    const gen = createUlidGenerator({ now: () => times.shift() ?? 0, randomBytes: zeros });
    const ids = [gen(), gen(), gen()];
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(3);
  });

  it("throws on random overflow within one millisecond", () => {
    const gen = createUlidGenerator({
      now: () => 1,
      randomBytes: () => new Uint8Array(10).fill(255),
    });
    gen();
    expect(() => gen()).toThrow(RangeError);
  });

  it("validates format", () => {
    expect(isUlid("01ARYZ6S410000000000000000")).toBe(true);
    expect(isUlid("81ARYZ6S410000000000000000")).toBe(false);
    expect(isUlid("01ARYZ6S41000000000000000U")).toBe(false);
    expect(isUlid("short")).toBe(false);
    expect(() => decodeTime("nope")).toThrow(TypeError);
    expect(() => encodeTime(-1)).toThrow(RangeError);
  });
});
