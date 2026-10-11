import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { MasteryCriteria } from "../graph/schema.js";
import {
  evaluateNodeState,
  masteredConditionMet,
  median,
  windowAccuracy,
  type GradedAttempt,
} from "./mastery.js";

const crit: MasteryCriteria = {
  minAccuracy: 0.9,
  maxMedianLatencyMs: 1500,
  windowAttempts: 10,
  distinctSessions: 2,
};

let seq = 0;
function att(over: Partial<GradedAttempt> = {}): GradedAttempt {
  seq += 1;
  return {
    at: seq,
    sessionId: "s1",
    day: "2026-10-01",
    mode: "instrument",
    correct: true,
    latencyMs: 1000,
    ...over,
  };
}

/** n attempts, the first half in session s1 on day 1, the rest in s2 on day 2. */
function spread(n: number, over: Partial<GradedAttempt> = {}): GradedAttempt[] {
  return Array.from({ length: n }, (_, i) =>
    att(
      i < n / 2
        ? { sessionId: "s1", day: "2026-10-01", ...over }
        : { sessionId: "s2", day: "2026-10-02", ...over },
    ),
  );
}

function wrongAt(xs: GradedAttempt[], count: number): GradedAttempt[] {
  return xs.map((a, i) => (i < count ? { ...a, correct: false } : a));
}

describe("median", () => {
  it.each([
    [[], Number.NaN],
    [[5], 5],
    [[3, 1, 2], 2],
    [[4, 1, 3, 2], 2.5],
  ] as [number[], number][])("%j -> %s", (xs, expected) => {
    expect(median(xs)).toBe(expected);
  });
});

describe("windowAccuracy", () => {
  it("is the mean score over the last window", () => {
    const xs = [att({ correct: false }), att(), att(), att({ correct: false })];
    expect(windowAccuracy(xs, 4)).toBe(0.5);
    expect(windowAccuracy(xs, 2)).toBe(0.5);
    expect(windowAccuracy(xs, 3)).toBeCloseTo(2 / 3);
    expect(windowAccuracy(xs, 99)).toBe(0.5);
  });
  it("uses partial credit, and zero for incorrect regardless of partial", () => {
    const xs = [att({ partial: 0.5 }), att({ partial: 1 }), att({ correct: false, partial: 0.9 })];
    expect(windowAccuracy(xs, 3)).toBe(0.5);
  });
  it("is 0 for no attempts", () => {
    expect(windowAccuracy([], 5)).toBe(0);
  });
});

describe("evaluateNodeState", () => {
  it.each(["locked", "available"] as const)("returns %s unchanged", (s) => {
    expect(evaluateNodeState(s, spread(20), crit)).toBe(s);
  });

  it("learning stays learning with too few attempts", () => {
    expect(evaluateNodeState("learning", spread(9), crit)).toBe("learning");
  });

  it("learning stays learning below minAccuracy", () => {
    expect(evaluateNodeState("learning", wrongAt(spread(10), 2), crit)).toBe("learning");
  });

  it("accuracy exactly at minAccuracy is enough", () => {
    expect(evaluateNodeState("learning", wrongAt(spread(10), 1), crit)).toBe("mastered");
  });

  it("learning -> fluent when only the fluent condition holds", () => {
    const oneDay = spread(10).map((a) => ({ ...a, day: "2026-10-01" }));
    expect(evaluateNodeState("learning", oneDay, crit)).toBe("fluent");
  });

  it("learning jumps straight to mastered when both conditions hold", () => {
    expect(evaluateNodeState("learning", spread(10), crit)).toBe("mastered");
  });

  it("fluent -> mastered", () => {
    expect(evaluateNodeState("fluent", spread(10), crit)).toBe("mastered");
  });

  it("only the last window counts", () => {
    const xs = [...spread(10, { correct: false }), ...spread(10)];
    expect(evaluateNodeState("learning", xs, crit)).toBe("mastered");
  });

  it("all-away perfect history reaches fluent but not mastered", () => {
    const xs = spread(30, { mode: "away" });
    expect(evaluateNodeState("learning", xs, crit)).toBe("fluent");
    expect(evaluateNodeState("fluent", xs, crit)).toBe("fluent");
  });

  it("too few instrument attempts blocks mastery", () => {
    const xs = [...spread(8, { mode: "away" }), ...spread(9)];
    expect(evaluateNodeState("fluent", xs, crit)).toBe("fluent");
  });

  it("away attempts after the instrument window do not block mastery", () => {
    const xs = [...spread(10), ...spread(1, { mode: "away", correct: false })];
    expect(evaluateNodeState("fluent", xs, crit)).toBe("mastered");
  });

  it("too few distinct days blocks mastery", () => {
    const sameDay = spread(10).map((a) => ({ ...a, day: "2026-10-01" }));
    expect(evaluateNodeState("fluent", sameDay, crit)).toBe("fluent");
  });

  it("too few distinct sessions blocks mastery", () => {
    const oneSession = spread(10).map((a) => ({ ...a, sessionId: "s1" }));
    expect(evaluateNodeState("fluent", oneSession, crit)).toBe("fluent");
  });

  it("median latency over the ceiling blocks mastery; exactly at it passes", () => {
    expect(evaluateNodeState("fluent", spread(10, { latencyMs: 1501 }), crit)).toBe("fluent");
    expect(evaluateNodeState("fluent", spread(10, { latencyMs: 1500 }), crit)).toBe("mastered");
  });

  it("median latency uses correct attempts only", () => {
    const xs = spread(10).map((a, i) => (i === 0 ? { ...a, correct: false, latencyMs: 99999 } : a));
    expect(evaluateNodeState("fluent", xs, crit)).toBe("mastered");
  });

  it("latency is ignored when maxMedianLatencyMs is undefined", () => {
    const noLat: MasteryCriteria = {
      minAccuracy: crit.minAccuracy,
      windowAttempts: crit.windowAttempts,
      distinctSessions: crit.distinctSessions,
    };
    expect(evaluateNodeState("fluent", spread(10, { latencyMs: 99999 }), noLat)).toBe("mastered");
  });

  it("partial credit lowers accuracy", () => {
    expect(evaluateNodeState("learning", spread(10, { partial: 0.85 }), crit)).toBe("learning");
    expect(evaluateNodeState("learning", spread(10, { partial: 0.9 }), crit)).toBe("mastered");
  });

  describe("demotion", () => {
    // minAccuracy 0.9 minus 0.1 margin = 0.8 over a window of 10.
    const histWithWrong = (wrong: number) => wrongAt(spread(10), wrong);
    it("exactly at the threshold does not demote", () => {
      expect(evaluateNodeState("mastered", histWithWrong(2), crit)).toBe("mastered");
    });
    it("strictly below the threshold demotes to fluent", () => {
      expect(evaluateNodeState("mastered", histWithWrong(3), crit)).toBe("fluent");
    });
    it("counts away attempts", () => {
      const xs = [...spread(10), ...spread(3, { mode: "away", correct: false })];
      expect(evaluateNodeState("mastered", xs, crit)).toBe("fluent");
    });
    it("needs a minimum sample before demoting (placement floor)", () => {
      const miss = [att({ correct: false })];
      expect(evaluateNodeState("mastered", miss, crit)).toBe("mastered");
      const fourMisses = Array.from({ length: 4 }, () => att({ correct: false }));
      expect(evaluateNodeState("mastered", fourMisses, crit)).toBe("mastered");
      const fiveMisses = Array.from({ length: 5 }, () => att({ correct: false }));
      expect(evaluateNodeState("mastered", fiveMisses, crit)).toBe("fluent");
    });
    it("does not demote below fluent", () => {
      expect(evaluateNodeState("fluent", spread(10, { correct: false }), crit)).toBe("fluent");
    });
  });
});

const sessionArb = fc.constantFrom("s1", "s2", "s3");
const dayArb = fc.constantFrom("2026-10-01", "2026-10-02", "2026-10-03");
const attemptArb = fc.record({
  at: fc.nat(),
  sessionId: sessionArb,
  day: dayArb,
  mode: fc.constant("instrument" as const),
  correct: fc.boolean(),
  latencyMs: fc.integer({ min: 0, max: 3000 }),
});
const awayArb = fc.record({
  at: fc.nat(),
  sessionId: sessionArb,
  day: dayArb,
  mode: fc.constant("away" as const),
  correct: fc.boolean(),
  latencyMs: fc.integer({ min: 0, max: 3000 }),
});

describe("properties", () => {
  it("interleaving away attempts never changes the mastered condition", () => {
    fc.assert(
      fc.property(
        fc.array(attemptArb, { maxLength: 30 }),
        fc.array(awayArb, { maxLength: 10 }),
        fc.nat(30),
        (inst, away, cut) => {
          const k = Math.min(cut, inst.length);
          const mixed = [...inst.slice(0, k), ...away, ...inst.slice(k)];
          expect(masteredConditionMet(mixed, crit)).toBe(masteredConditionMet(inst, crit));
        },
      ),
    );
  });

  it("an all-away history is never mastered", () => {
    fc.assert(
      fc.property(fc.array(awayArb, { maxLength: 40 }), (xs) => {
        expect(evaluateNodeState("learning", xs, crit)).not.toBe("mastered");
      }),
    );
  });
});
