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
    [{ code: "degree.confusion." }, "That was a different note from the target"],
    [
      {
        code: "choice.wrong",
        detail: { expectedLabel: "Major", playedLabel: "Minor", part: "play" },
      },
      "You chose minor; it was major",
    ],
    [{ code: "choice.wrong" }, "That was not the right choice"],
    [
      {
        code: "choice.wrong",
        detail: { expectedLabel: "I-V-vi-IV", playedLabel: "vi-IV-I-V", part: "play" },
      },
      "You chose vi-IV-I-V; it was I-V-vi-IV",
    ],
    [
      {
        code: "choice.wrong",
        detail: { expectedLabel: "Perfect", playedLabel: "Plagal", part: "play" },
      },
      "You chose plagal; it was perfect",
    ],
    [{ code: "pitch.wrong" }, "That was not the target note"],
    [{ code: "pitch.octave" }, "Right note, wrong octave"],
    [{ code: "response.timeout" }, "No answer was heard in time"],
    [{ code: "response.skipped" }, "Skipped"],
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
    [{ code: "sequence.wrong-note", detail: { index: 1 } }, "Note 2 was not the target"],
    [{ code: "something.new" }, "Something was off"],
  ];
  it.each(table)("%j", (error, text) => {
    expect(describeError(error)).toBe(text);
  });
});

describe("no sung wording (R29)", () => {
  it.each([
    { code: "degree.confusion.1-5", detail: { part: "sing" } },
    { code: "degree.confusion.", detail: { part: "sing" } },
    { code: "sequence.wrong-note", detail: { index: 2, expected: 43, played: 40, part: "sing" } },
    { code: "pitch.wrong", detail: { expected: 43, played: 40, part: "sing" } },
  ])("%j never says sang or sung", (error) => {
    const names = (m: number): string => `n${String(m)}`;
    expect(describeError(error)).not.toMatch(/sang|sung|sing/i);
    expect(describeError(error, names)).not.toMatch(/sang|sung|sing/i);
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
    ["fluent", 3, false, true],
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
    ).toEqual({
      correct: false,
      detailed: true,
      lines: ["That was not the target note"],
      autoAdvance: false,
    });
  });

  it("adds the right answer in words after a miss only", () => {
    const answer = "The note was 3, which is B in G major.";
    const wrong = buildFeedback({
      nodeState: "fluent",
      attemptIndex: 1,
      correct: false,
      errors: [{ code: "pitch.wrong" }],
      answer,
    });
    expect(wrong.answer).toBe(answer);
    const right = buildFeedback({
      nodeState: "learning",
      attemptIndex: 0,
      correct: true,
      errors: [],
      answer,
    });
    expect(right.answer).toBeUndefined();
  });
});

describe("concept tips in feedback", () => {
  const confusion: AttemptError[] = [{ code: "degree.confusion.3-5" }];
  const tip =
    "3 is the bright middle of the home chord, while 5 is the strong, open top of the home chord.";

  it.each([
    ["learning, wrong", "learning", 0, false, tip],
    ["fluent, wrong, detail shown", "fluent", 2, false, tip],
    ["fluent, wrong, odd attempt", "fluent", 1, false, tip],
    ["mastered, wrong", "mastered", 5, false, undefined],
    ["learning, right overall with an issue noted", "learning", 0, true, tip],
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

describe("describeError on reading items (named notes)", () => {
  const names = (midi: number): string =>
    ({ 38: "D2", 40: "E2", 52: "E3", 43: "G2" })[midi] ?? `m${String(midi)}`;
  const table: [AttemptError, string][] = [
    [
      { code: "pitch.wrong", detail: { expected: 38, played: 40 } },
      "You played E2. This note is D2.",
    ],
    [
      { code: "pitch.octave", detail: { expected: 40, played: 52, octaves: 1 } },
      "Right note, wrong octave. You played E3. This note is E2.",
    ],
    [
      { code: "sequence.wrong-note", detail: { index: 1, expected: 43, played: 40 } },
      "Note 2: you played E2; the target was G2",
    ],
    // Without numeric notes, or for other codes, the ear wording stands.
    [{ code: "pitch.wrong" }, "That was not the target note"],
    [{ code: "sequence.missing", detail: { index: 1 } }, "Note 2 was missing"],
  ];
  it.each(table)("%j -> %s", (error, line) => {
    expect(describeError(error, names)).toBe(line);
  });

  it("leaves ear wording unchanged without a namer", () => {
    expect(describeError({ code: "pitch.wrong", detail: { expected: 38, played: 40 } })).toBe(
      "That was not the target note",
    );
  });

  it("names notes in the feedback lines", () => {
    const view = buildFeedback({
      nodeState: "learning",
      attemptIndex: 0,
      correct: false,
      errors: [{ code: "pitch.wrong", detail: { expected: 38, played: 40 } }],
      names,
    });
    expect(view.lines).toEqual(["You played E2. This note is D2."]);
  });
});

describe("chord line errors", () => {
  const NAMES = new Map([
    [40, "E2"],
    [41, "F2"],
    [45, "A2"],
  ]);
  const names = (midi: number): string => NAMES.get(midi) ?? `n${String(midi)}`;
  const chord = { index: 1, roman: "IV", symbol: "F" };
  const table: [AttemptError, string][] = [
    [
      { code: "chord.wrong-tone", detail: { ...chord, expected: 41, played: 40, part: "play" } },
      "You played E instead of F in the IV chord.",
    ],
    [
      { code: "chord.missing-tone", detail: { ...chord, expected: 45 } },
      "You left out A in the IV chord.",
    ],
    [{ code: "chord.missed", detail: chord }, "The IV chord (F) was missed"],
    [{ code: "chord.extra", detail: { count: 1, played: 60 } }, "There was an extra note"],
    [{ code: "chord.extra", detail: { count: 3, played: 60 } }, "There were extra notes"],
    [{ code: "chord.early", detail: chord }, "The IV chord was early"],
    [{ code: "chord.late", detail: chord }, "The IV chord was late"],
  ];

  it.each(table)("%j", (error, line) => {
    expect(describeError(error, names)).toBe(line);
  });

  it("falls back to the chord alone when notes cannot be named", () => {
    expect(
      describeError({ code: "chord.wrong-tone", detail: { ...chord, expected: 41, played: 40 } }),
    ).toBe("A wrong note in the IV chord");
    expect(describeError({ code: "chord.missing-tone", detail: chord })).toBe(
      "A note of the IV chord was missing",
    );
  });
});
