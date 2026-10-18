import type { ExpectedResponse } from "@clavis/core";
import { describe, expect, it } from "vitest";
import { scoreChoice } from "./choice.js";
import { scoreAttempt } from "./score.js";

const options = [
  { id: "major", label: "Major" },
  { id: "minor", label: "Minor" },
  { id: "diminished", label: "Diminished" },
];
const base = { options, correct: "minor", stimulusEndMs: 1000, responseWindowMs: 8000 };

describe("scoreChoice", () => {
  // Table: answer, expected correct, latency, error codes.
  it.each([
    ["the right option", { id: "minor", atMs: 1700 }, true, 700, []],
    ["the right option instantly", { id: "minor", atMs: 1000 }, true, 0, []],
    ["the right option at the window edge", { id: "minor", atMs: 9000 }, true, 8000, []],
    ["a wrong option", { id: "major", atMs: 1900 }, false, 900, ["choice.wrong"]],
    ["no answer", undefined, false, 8000, ["response.timeout"]],
    ["an answer after the window", { id: "minor", atMs: 9001 }, false, 8000, ["response.timeout"]],
    [
      "an answer before the stimulus ended",
      { id: "minor", atMs: 900 },
      false,
      8000,
      ["response.timeout"],
    ],
  ] as const)("%s", (_name, answer, correct, latencyMs, codes) => {
    const r = scoreChoice({ ...base, answer });
    expect(r.outcome).toEqual({ correct, latencyMs, retries: 0 });
    expect(r.errors.map((e) => e.code)).toEqual(codes);
  });

  it("names both options in the wrong-answer error", () => {
    const r = scoreChoice({ ...base, answer: { id: "diminished", atMs: 2000 } });
    expect(r.errors).toEqual([
      {
        code: "choice.wrong",
        detail: {
          expected: "minor",
          played: "diminished",
          expectedLabel: "Minor",
          playedLabel: "Diminished",
        },
      },
    ]);
  });

  it("falls back to the id for an unknown option", () => {
    const r = scoreChoice({ ...base, answer: { id: "augmented", atMs: 2000 } });
    expect(r.errors[0]?.detail).toMatchObject({ playedLabel: "augmented" });
  });
});

describe("scoreAttempt with a choice item", () => {
  const expected: ExpectedResponse = {
    play: { kind: "choice", options, correct: "major" },
    responseWindowMs: 8000,
  };
  const input = { expected, notes: [], stimulusEndMs: 1000, source: "tap" as const };

  it("scores the picked option, ignoring notes", () => {
    const right = scoreAttempt({ ...input, choice: { id: "major", atMs: 1500 } });
    expect(right.outcome.correct).toBe(true);
    expect(right.subScores).toEqual({ play: 1 });
    const wrong = scoreAttempt({ ...input, choice: { id: "minor", atMs: 1500 } });
    expect(wrong.outcome.correct).toBe(false);
    expect(wrong.errors[0]?.code).toBe("choice.wrong");
    expect(wrong.errors[0]?.detail).not.toHaveProperty("part");
  });

  it("times out without a pick", () => {
    const r = scoreAttempt(input);
    expect(r.outcome).toMatchObject({ correct: false, latencyMs: 8000 });
    expect(r.errors.map((e) => e.code)).toEqual(["response.timeout"]);
  });
});
