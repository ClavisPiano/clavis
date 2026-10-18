import { createRng, progressionId, type SkillNode } from "@clavis/core";
import { scoreAttempt } from "@clavis/scoring";
import { describe, expect, it } from "vitest";
import { describeError } from "./session/feedback";

// Integration test: core cannot import scoring and scoring may only import core types, so the web
// app, which depends on both, checks that every progressionId item scores from a tap the way the
// learner will experience it, including in Away mode, and that the tip line names both options.
const mastery = { minAccuracy: 0.9, windowAttempts: 20, distinctSessions: 2 };
const base = {
  strand: "EAR" as const,
  prerequisites: [],
  itemGenerators: ["progressionId" as const],
  mastery,
  keyDependent: false,
  targetLatencyMs: 3000,
};
const nodes: SkillNode[] = [
  {
    ...base,
    id: "ear.prog.core",
    title: "Core progressions",
    params: {
      mode: "major",
      progressions: [
        ["I", "V", "vi", "IV"],
        ["I", "IV", "V"],
        ["ii", "V", "I"],
        ["vi", "IV", "I", "V"],
      ],
    },
  },
  {
    ...base,
    id: "ear.cadence",
    title: "Cadences",
    params: {
      mode: "major",
      cadences: {
        perfect: ["V", "I"],
        plagal: ["IV", "I"],
        imperfect: ["I", "V"],
        deceptive: ["V", "vi"],
      },
    },
  },
];

const generate = (node: SkillNode, params: Record<string, unknown>, mode: "away" | "instrument") =>
  progressionId.generate(node, params as never, {
    rng: createRng(11),
    mode,
  });

describe("progressionId against scoreAttempt", () => {
  it.each(["away", "instrument"] as const)("scores a tap on every item in %s mode", (mode) => {
    for (const node of nodes) {
      for (const params of progressionId.listItems(node)) {
        const inst = generate(node, params, mode);
        const play = inst.expected.play;
        if (play?.kind !== "choice") throw new Error("expected a choice target");
        const input = {
          expected: inst.expected,
          notes: [],
          stimulusEndMs: 1000,
          source: "tap" as const,
        };
        const right = scoreAttempt({ ...input, choice: { id: play.correct, atMs: 1800 } });
        expect(right.outcome.correct, inst.itemId).toBe(true);
        expect(right.outcome.latencyMs).toBe(800);
        const otherId = play.options.find((o) => o.id !== play.correct)?.id ?? "";
        const wrong = scoreAttempt({ ...input, choice: { id: otherId, atMs: 1800 } });
        expect(wrong.outcome.correct, inst.itemId).toBe(false);
        expect(wrong.errors[0]?.code).toBe("choice.wrong");
      }
    }
  });

  it("names the heard and chosen progression in the tip line", () => {
    const [core, cadence] = nodes as [SkillNode, SkillNode];
    const inst = generate(core, { prog: ["I", "IV", "V"] }, "away");
    const r = scoreAttempt({
      expected: inst.expected,
      notes: [],
      stimulusEndMs: 1000,
      source: "tap",
      choice: { id: "ii-V-I", atMs: 1500 },
    });
    const error = r.errors[0];
    if (!error) throw new Error("expected an error");
    expect(describeError(error)).toBe("You chose ii-V-I; it was I-IV-V");

    const cad = generate(cadence, { cadence: "perfect" }, "away");
    const c = scoreAttempt({
      expected: cad.expected,
      notes: [],
      stimulusEndMs: 1000,
      source: "tap",
      choice: { id: "plagal", atMs: 1500 },
    });
    const cadError = c.errors[0];
    if (!cadError) throw new Error("expected an error");
    expect(describeError(cadError)).toBe("You chose plagal; it was perfect");
  });
});
