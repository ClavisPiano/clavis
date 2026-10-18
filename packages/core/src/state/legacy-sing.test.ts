import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { LearningEvent } from "../events/schema.js";
import { validateBatch } from "../events/validate.js";
import { foldEvents, type LearnerState } from "./index.js";
import { Builder, DAY_MS, T0, ctx } from "./test-helpers.js";

/*
 * R29: singing is no longer graded, but earlier attempts carry `sing` sub-scores (and errors tagged
 * with the sung part), and earlier settings carry a voice range. All of it must still parse and
 * fold, and must change nothing the learner sees.
 */

const C = ctx();
const fold = (events: readonly LearningEvent[]): LearnerState => foldEvents(events, C);

/** The same log as written under R12: a sung part beside the played one, and a voice range. */
function asWrittenUnderR12(events: readonly LearningEvent[]): LearningEvent[] {
  return events.map((e) => {
    if (e.type === "attempt.completed") {
      return {
        ...e,
        subScores: { sing: e.outcome.correct ? 1 : 0.4, play: e.outcome.correct ? 1 : 0.5 },
        inputSource: "mic",
      };
    }
    return e;
  });
}

function log(b: Builder, sessions: number): LearningEvent[] {
  return [
    b.register(T0),
    b.settings(T0 + 1, { budgetSec: 600 }),
    ...Array.from({ length: sessions }, (_, i) =>
      b.session(T0 + (i + 1) * DAY_MS, i + 1, "n1", 4, { introduce: i === 0 }),
    ).flat(),
  ];
}

/** Everything except the attempts' sub-scores and input source, which is what R12 logs added. */
function withoutSungDetail(state: LearnerState): unknown {
  return JSON.parse(
    JSON.stringify(state, (key, value: unknown) =>
      key === "subScores" || key === "inputSource" ? undefined : value,
    ),
  );
}

describe("logs written under R12 (sung parts, voice range)", () => {
  it("parse as events", () => {
    const old = asWrittenUnderR12(log(new Builder(), 2));
    const withVoice = [
      ...old,
      new Builder("dev-b", "B").settings(T0 + 5, { voiceRangeLow: 40, voiceRangeHigh: 64 }),
    ];
    expect(() => validateBatch(withVoice)).not.toThrow();
  });

  it("fold to the same learner state as the played-only log", () => {
    const events = log(new Builder(), 3);
    const before = fold(events);
    const after = fold(asWrittenUnderR12(events));
    expect(withoutSungDetail(after)).toStrictEqual(withoutSungDetail(before));
    expect(after.nodes).toStrictEqual(before.nodes);
    expect(after.cards).toStrictEqual(before.cards);
  });

  it("keep a stored voice range without letting it change anything else", () => {
    const b = new Builder();
    const events = log(b, 2);
    const withVoice = [...events, b.settings(T0 + 9, { voiceRangeLow: 40, voiceRangeHigh: 64 })];
    const a = fold(events);
    const v = fold(withVoice);
    expect(v.settings).toEqual({ ...a.settings, voiceRangeLow: 40, voiceRangeHigh: 64 });
    expect(v.nodes).toStrictEqual(a.nodes);
    expect(v.cards).toStrictEqual(a.cards);
    expect(v.attempts).toStrictEqual(a.attempts);
  });

  it("property: refold is order independent with sung sub-scores present", () => {
    const events = asWrittenUnderR12(log(new Builder(), 3));
    const expected = fold(events);
    fc.assert(
      fc.property(fc.shuffledSubarray(events, { minLength: events.length }), (shuffled) => {
        expect(fold(shuffled)).toStrictEqual(expected);
      }),
      { numRuns: 50 },
    );
  });

  it("property: replaying the log twice is the same as once", () => {
    const events = asWrittenUnderR12(log(new Builder(), 3));
    expect(fold([...events, ...events])).toStrictEqual(fold(events));
  });
});
