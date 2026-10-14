import type { ChoiceOption } from "@clavis/core";
import type { PartResult } from "./single.js";
import { err } from "./util.js";

export interface ChoiceAnswer {
  /** The `id` of the option the learner picked. */
  id: string;
  /** When they picked it, on the same clock as `stimulusEndMs`. */
  atMs: number;
}

export interface ChoiceInput {
  options: readonly ChoiceOption[];
  /** The `id` of the right option. */
  correct: string;
  answer: ChoiceAnswer | undefined;
  stimulusEndMs: number;
  responseWindowMs: number;
}

/**
 * Score a pick (R21). Right option: correct, with the time taken. Another option: incorrect, with
 * a `choice.wrong` error naming both. No pick, or one outside the response window, is a timeout.
 */
export function scoreChoice(input: ChoiceInput): PartResult {
  const { answer } = input;
  const latencyMs =
    answer === undefined ? input.responseWindowMs : answer.atMs - input.stimulusEndMs;
  if (answer === undefined || latencyMs < 0 || latencyMs > input.responseWindowMs) {
    return {
      outcome: { correct: false, latencyMs: input.responseWindowMs, retries: 0 },
      errors: [err("response.timeout")],
    };
  }
  if (answer.id === input.correct) {
    return { outcome: { correct: true, latencyMs, retries: 0 }, errors: [] };
  }
  const label = (id: string): string => input.options.find((o) => o.id === id)?.label ?? id;
  return {
    outcome: { correct: false, latencyMs, retries: 0 },
    errors: [
      err("choice.wrong", {
        expected: input.correct,
        played: answer.id,
        expectedLabel: label(input.correct),
        playedLabel: label(answer.id),
      }),
    ],
  };
}
