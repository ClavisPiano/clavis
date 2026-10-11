import { describe, expect, it } from "vitest";
import { parseBudget, parseLatency, parseSessionParams } from "./params";

const q = (s: string) => new URLSearchParams(s);

describe("parseSessionParams", () => {
  it("defaults: instrument mode, mic, real audio, headphones decided later", () => {
    expect(parseSessionParams(q(""))).toEqual({
      mode: "instrument",
      budgetSec: undefined,
      inputKind: "mic",
      silent: false,
      headphones: undefined,
    });
  });

  it("away mode taps by default", () => {
    expect(parseSessionParams(q("mode=away")).inputKind).toBe("tap");
  });

  it("fake input implies silent audio and skips the headphones prompt", () => {
    const p = parseSessionParams(q("input=fake"));
    expect(p).toMatchObject({ inputKind: "fake", silent: true, headphones: true });
  });

  it("headphones can be forced", () => {
    expect(parseSessionParams(q("input=fake&headphones=ask")).headphones).toBe("ask");
    expect(parseSessionParams(q("headphones=no")).headphones).toBe(false);
    expect(parseSessionParams(q("headphones=yes")).headphones).toBe(true);
  });

  it("audio=silent alone keeps the chosen input", () => {
    expect(parseSessionParams(q("audio=silent"))).toMatchObject({ silent: true, inputKind: "mic" });
  });

  it("budget override must be a sane whole number of seconds", () => {
    expect(parseBudget("90")).toBe(90);
    expect(parseBudget("5")).toBeUndefined();
    expect(parseBudget("abc")).toBeUndefined();
    expect(parseBudget("1.5")).toBeUndefined();
    expect(parseBudget("99999")).toBeUndefined();
    expect(parseBudget(null)).toBeUndefined();
    expect(parseSessionParams(q("budget=120")).budgetSec).toBe(120);
  });
});

describe("parseLatency", () => {
  it("accepts numeric tap and mic offsets and ignores everything else", () => {
    expect(parseLatency({ tapMs: 40, micMs: 120, extra: 1 })).toEqual({ tapMs: 40, micMs: 120 });
    expect(parseLatency({ micMs: "x" })).toEqual({});
    expect(parseLatency({ tapMs: Number.NaN })).toEqual({});
    expect(parseLatency(null)).toEqual({});
    expect(parseLatency(undefined)).toEqual({});
    expect(parseLatency(5)).toEqual({});
  });
});
