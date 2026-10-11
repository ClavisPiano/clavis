import type { AttemptError, NodeState } from "@clavis/core";
import { describe, expect, it } from "vitest";
import { buildFeedback, describeError, issueLines, showDetail } from "./feedback";

describe("describeError", () => {
  const table: [AttemptError, string][] = [
    [{ code: "degree.confusion.6-5" }, "You played 5; the target was 6"],
    [
      { code: "degree.confusion.b3-3", detail: { part: "play" } },
      "You played 3; the target was b3",
    ],
    [{ code: "degree.confusion.1-5", detail: { part: "sing" } }, "You sang 5; the target was 1"],
    [{ code: "degree.confusion." }, "That was a different note from the target"],
    [
      { code: "degree.confusion.", detail: { part: "sing" } },
      "You sang a different note from the target",
    ],
    [{ code: "pitch.wrong" }, "That was not the target note"],
    [{ code: "pitch.octave" }, "Right note, wrong octave"],
    [{ code: "response.timeout" }, "No answer was heard in time"],
    [{ code: "response.skipped" }, "Skipped"],
    [{ code: "sing.flat", detail: { cents: -30 } }, "A little flat"],
    [{ code: "sing.sharp" }, "A little sharp"],
    [{ code: "sing.none" }, "No steady sung note was heard"],
    [{ code: "rhythm.late", detail: { index: 2 } }, "Note 3 was late"],
    [{ code: "rhythm.early", detail: { index: 0 } }, "Note 1 was early"],
    [{ code: "rhythm.missed", detail: { index: 4 } }, "Note 5 was missed"],
    [{ code: "rhythm.extra" }, "There was an extra tap"],
    [{ code: "rhythm.tempo-drift", detail: { ratio: 1.2 } }, "You rushed the tempo"],
    [{ code: "rhythm.tempo-drift", detail: { ratio: 0.8 } }, "You dragged the tempo"],
    [{ code: "rhythm.tempo-drift" }, "The tempo drifted"],
    [{ code: "sequence.missing", detail: { index: 1 } }, "Note 2 was missing"],
    [{ code: "sequence.extra" }, "There was an extra note"],
    [
      {
        code: "sequence.wrong-note",
        detail: { index: 0, expectedDegree: "5", playedDegree: "4" },
      },
      "Note 1: you played 4; the target was 5",
    ],
    [
      {
        code: "sequence.wrong-note",
        detail: { index: 2, expectedDegree: "3", playedDegree: "2", part: "sing" },
      },
      "Note 3: you sang 2; the target was 3",
    ],
    [{ code: "sequence.wrong-note", detail: { index: 1 } }, "Note 2 was not the target"],
    [{ code: "something.new" }, "Something was off"],
  ];
  it.each(table)("%j", (error, text) => {
    expect(describeError(error)).toBe(text);
  });
});

describe("issueLines", () => {
  it("keeps at most two distinct lines in order", () => {
    const errors: AttemptError[] = [
      { code: "rhythm.late", detail: { index: 1 } },
      { code: "rhythm.late", detail: { index: 1 } },
      { code: "rhythm.missed", detail: { index: 3 } },
      { code: "rhythm.extra" },
    ];
    expect(issueLines(errors)).toEqual(["Note 2 was late", "Note 4 was missed"]);
    expect(issueLines([])).toEqual([]);
  });
});

describe("fading by node state", () => {
  const cases: [NodeState, number, boolean, boolean][] = [
    // state, prior attempts, correct, shows detail
    ["available", 0, true, true],
    ["learning", 0, true, true],
    ["learning", 1, true, true],
    ["learning", 7, false, true],
    ["fluent", 0, true, true],
    ["fluent", 1, true, false],
    ["fluent", 2, true, true],
    ["fluent", 3, false, false],
    ["mastered", 0, true, false],
    ["mastered", 5, true, false],
    ["mastered", 5, false, true],
  ];
  it.each(cases)(
    "%s after %i attempts, correct=%s -> detail %s",
    (state, index, correct, shown) => {
      expect(showDetail(state, index, correct)).toBe(shown);
    },
  );

  it("auto-advances only when correct and faded out", () => {
    const err: AttemptError[] = [{ code: "pitch.wrong" }];
    expect(
      buildFeedback({ nodeState: "mastered", attemptIndex: 4, correct: true, errors: [] }),
    ).toEqual({ correct: true, detailed: false, lines: [], autoAdvance: true });
    expect(
      buildFeedback({ nodeState: "mastered", attemptIndex: 4, correct: false, errors: err }),
    ).toEqual({
      correct: false,
      detailed: true,
      lines: ["That was not the target note"],
      autoAdvance: false,
    });
    expect(
      buildFeedback({ nodeState: "fluent", attemptIndex: 1, correct: false, errors: err }),
    ).toEqual({ correct: false, detailed: false, lines: [], autoAdvance: false });
  });
});

describe("concept tips in feedback", () => {
  const confusion: AttemptError[] = [{ code: "degree.confusion.3-5" }];
  const tip =
    "3 is the bright middle of the home chord, while 5 is the strong, open top of the home chord.";

  it.each([
    ["learning, wrong", "learning", 0, false, tip],
    ["fluent, wrong, detail shown", "fluent", 2, false, tip],
    ["fluent, wrong, detail faded", "fluent", 1, false, undefined],
    ["mastered, wrong", "mastered", 5, false, undefined],
    ["learning, right overall with a wrong sung part", "learning", 0, true, tip],
  ] as const)("%s", (_name, nodeState, attemptIndex, correct, expected) => {
    const fb = buildFeedback({ nodeState, attemptIndex, correct, errors: confusion });
    expect(fb.tip).toBe(expected);
  });

  it("has no tip without errors", () => {
    const fb = buildFeedback({ nodeState: "learning", attemptIndex: 0, correct: true, errors: [] });
    expect(fb.tip).toBeUndefined();
  });

  it("reads degree labels in the item's mode", () => {
    const fb = buildFeedback({
      nodeState: "learning",
      attemptIndex: 0,
      correct: false,
      errors: confusion,
      mode: "minor",
    });
    expect(fb.tip).toMatch(/^3 is the dark middle of the minor home chord/);
  });
});
