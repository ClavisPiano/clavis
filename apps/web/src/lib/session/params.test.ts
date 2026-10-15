import { describe, expect, it } from "vitest";
import { parseBudget, parseLatency, parseSessionParams, parseSkills } from "./params";

const q = (s: string) => new URLSearchParams(s);

describe("parseSessionParams", () => {
  it("defaults: instrument mode, mic, real audio, headphones decided later", () => {
    expect(parseSessionParams(q(""))).toEqual({
      mode: "instrument",
      budgetSec: undefined,
      inputKind: "mic",
      silent: false,
      headphones: undefined,
      practice: false,
      learn: false,
    });
  });

  it("?run=piece.<id> plays that piece through, in instrument mode only", () => {
    expect(parseSessionParams(q("run=piece.hot-cross-buns")).run).toBe("piece.hot-cross-buns");
    expect(parseSessionParams(q("")).run).toBeUndefined();
    expect(parseSessionParams(q("run=piece.hot-cross-buns&mode=away")).run).toBeUndefined();
    for (const raw of [
      "run=hot-cross-buns",
      "run=piece.",
      "run=piece.Hot_Cross",
      "run=piece.a/../b",
      "run=",
      "run=read.bass.landmarks",
    ]) {
      expect(parseSessionParams(q(raw)).run, raw).toBeUndefined();
    }
  });

  it("?practice=1 sets practice, nothing else does", () => {
    expect(parseSessionParams(q("practice=1")).practice).toBe(true);
    expect(parseSessionParams(q("practice=1&mode=away"))).toMatchObject({
      practice: true,
      mode: "away",
    });
    for (const raw of ["practice=0", "practice=true", "practice=", ""]) {
      expect(parseSessionParams(q(raw)).practice).toBe(false);
    }
  });

  it("?learn=1 sets learn, and practice wins when both are set", () => {
    expect(parseSessionParams(q("learn=1")).learn).toBe(true);
    expect(parseSessionParams(q("learn=1&mode=away"))).toMatchObject({ learn: true, mode: "away" });
    expect(parseSessionParams(q("learn=1&practice=1"))).toMatchObject({
      learn: false,
      practice: true,
    });
    for (const raw of ["learn=0", "learn=true", "learn=", "practice=1", ""]) {
      expect(parseSessionParams(q(raw)).learn).toBe(false);
    }
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

describe("?skills=", () => {
  it("lists the skills to practise, only with practice", () => {
    expect(
      parseSessionParams(q("practice=1&skills=read.bass.landmarks,ear.rhythm.echo")).skills,
    ).toEqual(["read.bass.landmarks", "ear.rhythm.echo"]);
    expect(parseSessionParams(q("skills=read.bass.landmarks")).skills).toBeUndefined();
    expect(parseSessionParams(q("practice=1")).skills).toBeUndefined();
  });

  it("drops malformed ids and repeats", () => {
    expect(parseSkills("a.b,a.b,../x,ok-1,,%20")).toEqual(["a.b", "ok-1"]);
    expect(parseSkills("../x,,")).toBeUndefined();
    expect(parseSkills(null)).toBeUndefined();
  });
});
