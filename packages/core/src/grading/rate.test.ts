import { describe, expect, it } from "vitest";
import type { AttemptOutcome } from "../events/learning.js";
import type { Rating, SessionMode } from "../learning/rating.js";
import { rate } from "./rate.js";

interface Row {
  name: string;
  outcome: Partial<AttemptOutcome>;
  target?: number;
  mode?: SessionMode;
  expected: Rating;
}

const rows: Row[] = [
  { name: "incorrect", outcome: { correct: false }, target: 1000, expected: "again" },
  { name: "incorrect, no target", outcome: { correct: false }, expected: "again" },
  { name: "partial just below 0.6", outcome: { partial: 0.59 }, target: 1000, expected: "again" },
  { name: "partial exactly 0.6 passes", outcome: { partial: 0.6 }, target: 1000, expected: "good" },
  {
    name: "partial 0.6 fast",
    outcome: { partial: 0.6, latencyMs: 100 },
    target: 1000,
    expected: "easy",
  },
  { name: "retry", outcome: { retries: 1 }, target: 1000, expected: "hard" },
  { name: "retry, no target", outcome: { retries: 2 }, expected: "hard" },
  {
    name: "retry beats fast",
    outcome: { retries: 1, latencyMs: 10 },
    target: 1000,
    expected: "hard",
  },
  { name: "latency exactly 1.5x", outcome: { latencyMs: 1500 }, target: 1000, expected: "good" },
  { name: "latency just over 1.5x", outcome: { latencyMs: 1501 }, target: 1000, expected: "hard" },
  { name: "latency exactly 0.6x", outcome: { latencyMs: 600 }, target: 1000, expected: "easy" },
  { name: "latency just over 0.6x", outcome: { latencyMs: 601 }, target: 1000, expected: "good" },
  { name: "mid latency", outcome: { latencyMs: 1000 }, target: 1000, expected: "good" },
  { name: "no target ignores slow", outcome: { latencyMs: 99999 }, expected: "good" },
  { name: "no target ignores fast", outcome: { latencyMs: 0 }, expected: "good" },
  {
    name: "away caps easy",
    outcome: { latencyMs: 100 },
    target: 1000,
    mode: "away",
    expected: "good",
  },
  {
    name: "away keeps hard",
    outcome: { retries: 1 },
    target: 1000,
    mode: "away",
    expected: "hard",
  },
  {
    name: "away keeps again",
    outcome: { correct: false },
    target: 1000,
    mode: "away",
    expected: "again",
  },
  {
    name: "away good stays good",
    outcome: { latencyMs: 1000 },
    target: 1000,
    mode: "away",
    expected: "good",
  },
];

describe("rate", () => {
  it.each(rows)("$name -> $expected", ({ outcome, target, mode, expected }) => {
    const full: AttemptOutcome = { correct: true, latencyMs: 1000, retries: 0, ...outcome };
    const m = mode ?? "instrument";
    const opts = target === undefined ? { mode: m } : { mode: m, targetLatencyMs: target };
    expect(rate(full, opts)).toBe(expected);
  });
});
