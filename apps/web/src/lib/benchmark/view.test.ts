import type { BenchmarkOption, BenchmarkRecord, Piece } from "@clavis/core";
import { describe, expect, it } from "vitest";
import { clockLabel, defaultBenchmarkPiece, monthLabel } from "./view";

const option = (id: string, unlocked: boolean): BenchmarkOption => ({
  piece: { id } as Piece,
  unlocked,
});
const rec = (month: string, pieceId: string) => ({ month, pieceId }) as BenchmarkRecord;

describe("benchmark view helpers", () => {
  it.each([
    ["2026-10", "October 2026"],
    ["2027-01", "January 2027"],
    ["bad", "bad"],
  ])("monthLabel(%s)", (m, label) => {
    expect(monthLabel(m)).toBe(label);
  });

  it.each([
    [0, "0:00"],
    [59_999, "0:59"],
    [61_000, "1:01"],
    [180_000, "3:00"],
  ])("clockLabel(%i)", (ms, label) => {
    expect(clockLabel(ms)).toBe(label);
  });

  it("starts on the last benchmarked piece, else the hardest unlocked, else the first", () => {
    const opts = [option("a", true), option("b", true), option("c", false)];
    expect(defaultBenchmarkPiece(opts, {})).toBe("b");
    expect(
      defaultBenchmarkPiece(opts, {
        "2026-08": rec("2026-08", "c"),
        "2026-09": rec("2026-09", "a"),
      }),
    ).toBe("a");
    expect(defaultBenchmarkPiece(opts, { "2026-09": rec("2026-09", "gone") })).toBe("b");
    expect(defaultBenchmarkPiece([option("x", false), option("y", false)], {})).toBe("x");
    expect(defaultBenchmarkPiece([], {})).toBeUndefined();
  });
});
