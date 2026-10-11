import { describe, expect, it } from "vitest";
import { daysBetween, learnerDay, learnerDayNumber } from "./day.js";

const utc = (iso: string) => Date.parse(iso);

describe("learnerDay", () => {
  it("rolls over at 04:00 local time", () => {
    // Sydney (+600): 03:59 local on the 12th is still the 11th.
    expect(learnerDay(utc("2026-10-11T17:59:00Z"), 600)).toBe("2026-10-11");
    expect(learnerDay(utc("2026-10-11T18:00:00Z"), 600)).toBe("2026-10-12");
  });

  it("handles negative offsets", () => {
    // New York (-240): 23:30 local on the 10th.
    expect(learnerDay(utc("2026-10-11T03:30:00Z"), -240)).toBe("2026-10-10");
  });

  it("is consistent with learnerDayNumber", () => {
    const at = utc("2026-01-01T12:00:00Z");
    expect(learnerDayNumber(at, 0) + 1).toBe(learnerDayNumber(at + 86_400_000, 0));
  });

  it("counts days between", () => {
    expect(daysBetween("2026-10-11", "2026-10-13")).toBe(2);
    expect(daysBetween("2026-10-13", "2026-10-11")).toBe(-2);
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2);
  });
});
