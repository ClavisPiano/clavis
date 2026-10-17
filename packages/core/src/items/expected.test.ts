import { describe, expect, it } from "vitest";
import { ExpectedResponseSchema } from "./expected.js";

const labels = ["1", "b2", "2", "b3", "3", "4", "#4", "5", "b6", "6", "b7", "7"];

describe("ExpectedResponseSchema", () => {
  it("still parses a sing-then-play item written under R12", () => {
    const r = ExpectedResponseSchema.safeParse({
      sing: { kind: "sungPitch", targetMidi: 64, toleranceCents: 50 },
      play: { kind: "pitchClass", targetMidi: 64, degreeLabels: labels },
      responseWindowMs: 8000,
    });
    expect(r.success).toBe(true);
  });

  it("accepts a rhythm item", () => {
    const r = ExpectedResponseSchema.safeParse({
      play: { kind: "rhythm", onsetsBeats: [0, 1, 1.5, 2], tempoBpm: 90, beatsPerBar: 4 },
      responseWindowMs: 10000,
    });
    expect(r.success).toBe(true);
  });

  it("accepts a choice item and rejects bad ones", () => {
    const options = [
      { id: "major", label: "Major" },
      { id: "minor", label: "Minor" },
    ];
    const ok = (play: unknown) =>
      ExpectedResponseSchema.safeParse({ play, responseWindowMs: 8000 }).success;
    expect(ok({ kind: "choice", options, correct: "minor" })).toBe(true);
    expect(ok({ kind: "choice", options, correct: "diminished" })).toBe(false);
    expect(ok({ kind: "choice", options: [options[0]], correct: "major" })).toBe(false);
    expect(ok({ kind: "choice", options: [options[0], options[0]], correct: "major" })).toBe(false);
  });

  it("accepts a performance and rejects bad ones", () => {
    const note = (id: string, hand: string, onsetBeats = 0) => ({
      id,
      midi: hand === "rh" ? 67 : 43,
      onsetBeats,
      durationBeats: 1,
      hand,
    });
    const ok = (notes: unknown[], extra: object = {}) =>
      ExpectedResponseSchema.safeParse({
        play: { kind: "performance", notes, tempoBpm: 60, beatsPerBar: 4, ...extra },
        responseWindowMs: 20000,
      }).success;
    expect(ok([note("n1", "rh"), note("n2.0", "lh"), note("n2.1", "lh")])).toBe(true);
    expect(ok([])).toBe(false);
    expect(ok([note("n1", "rh"), note("n1", "lh")])).toBe(false);
    expect(ok([note("n1", "both")])).toBe(false);
    expect(ok([note("n1", "rh", -1)])).toBe(false);
    expect(ok([note("n1", "rh")], { beatsPerBar: 0 })).toBe(false);
  });

  it("rejects an empty response", () => {
    expect(ExpectedResponseSchema.safeParse({ responseWindowMs: 1000 }).success).toBe(false);
  });

  it("rejects degree labels of the wrong length", () => {
    const r = ExpectedResponseSchema.safeParse({
      play: { kind: "pitchClass", targetMidi: 60, degreeLabels: ["1"] },
      responseWindowMs: 1000,
    });
    expect(r.success).toBe(false);
  });
});
