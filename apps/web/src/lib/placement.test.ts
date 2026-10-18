import { describe, expect, it } from "vitest";
import { loadGraph } from "@clavis/content";
import { createRng, type LearnerState } from "@clavis/core";
import {
  hasPlacement,
  placementPlanFor,
  placementStoredInput,
  shouldOfferPlacement,
} from "./placement";

describe("placement input (T5.9)", () => {
  it("honours a stored MIDI choice only", () => {
    expect(placementStoredInput("midi")).toBe("midi");
    for (const v of ["mic", "tap", "fake", "", null]) expect(placementStoredInput(v)).toBeNull();
  });

  it("plans the HANDS section for MIDI and for no other input", () => {
    const graph = loadGraph();
    const sections = (kind: string) =>
      new Set(placementPlanFor(graph, createRng(1), kind).stages.map((s) => s.section));
    expect([...sections("midi")]).toEqual(["EAR", "READ", "HANDS"]);
    for (const kind of ["mic", "tap", "fake"]) expect(sections(kind).has("HANDS")).toBe(false);
  });
});

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
