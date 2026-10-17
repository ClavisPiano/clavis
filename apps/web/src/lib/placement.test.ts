import { describe, expect, it } from "vitest";
import type { LearnerState } from "@clavis/core";
import { hasPlacement, shouldOfferPlacement } from "./placement";

function state(over: Partial<LearnerState> = {}): LearnerState {
  return {
    cards: {},
    nodes: {},
    attempts: {},
    sessions: {},
    presented: {},
    durations: {},
    daily: {},
    keyOfDayHistory: [],
    pieces: {},
    imported: {},
    benchmarks: {},
    settings: {},
    eventCount: 1,
    warnings: 0,
    ...over,
  };
}

describe("shouldOfferPlacement", () => {
  it("offers on a fresh profile", () => {
    expect(shouldOfferPlacement(state(), false)).toBe(true);
  });

  it("does not offer after a skip", () => {
    expect(shouldOfferPlacement(state(), true)).toBe(false);
  });

  it("does not offer once a session exists", () => {
    const s = state({ sessions: { s1: {} as unknown as LearnerState["sessions"][string] } });
    expect(shouldOfferPlacement(s, false)).toBe(false);
  });

  it("does not offer after a placement", () => {
    const s = state({
      nodes: {
        n: {
          state: "mastered",
          placementFloor: "mastered",
        } as unknown as LearnerState["nodes"][string],
      },
    });
    expect(hasPlacement(s)).toBe(true);
    expect(shouldOfferPlacement(s, false)).toBe(false);
  });
});
