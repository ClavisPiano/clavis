import { describe, expect, it } from "vitest";
import { percentile, round1 } from "./bench-stats";

describe("percentile", () => {
  const ten = [10, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  it.each([
    [50, 5],
    [95, 10],
    [100, 10],
    [0, 1],
    [10, 1],
    [11, 2],
  ])("p%d of 1..10 is %d", (p, expected) => {
    expect(percentile(ten, p)).toBe(expected);
  });
  it("handles empty and single inputs", () => {
    expect(percentile([], 50)).toBeNaN();
    expect(percentile([7], 95)).toBe(7);
  });
  it("rounds to one decimal", () => {
    expect(round1(1.26)).toBe(1.3);
  });
});
