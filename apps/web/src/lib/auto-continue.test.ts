import { describe, expect, it } from "vitest";
import { AUTO_CONTINUE_DEFAULT_SEC, parseAutoContinueSec } from "./auto-continue";

describe("parseAutoContinueSec", () => {
  it.each([
    [undefined, AUTO_CONTINUE_DEFAULT_SEC],
    ["5", AUTO_CONTINUE_DEFAULT_SEC],
    [Number.NaN, AUTO_CONTINUE_DEFAULT_SEC],
    [0, 0],
    [4, 4],
    [2.6, 3],
    [-2, 0],
    [60, 10],
  ])("%j -> %s", (raw, expected) => {
    expect(parseAutoContinueSec(raw)).toBe(expected);
  });
});
