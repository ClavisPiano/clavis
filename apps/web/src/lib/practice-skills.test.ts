import { loadGraph } from "@clavis/content";
import { initialState } from "@clavis/core";
import { createScheduler } from "@clavis/core";
import { describe, expect, it } from "vitest";
import { practiceSearch, practiceSkills } from "./practice-skills";

const graph = loadGraph();
const state = () => initialState({ graph, scheduler: createScheduler() });
const card = (nodeId: string) => ({ nodeId, card: {} as never, lastAttemptAt: 0, reps: 1 });

describe("practiceSkills", () => {
  it("offers started skills that have answered items, in graph order", () => {
    const s = state();
    s.nodes["ear.degrees.major.135"] = { state: "mastered" };
    s.nodes["ear.rhythm.echo"] = { state: "learning" };
    s.nodes["read.bass.landmarks"] = { state: "learning" };
    s.cards.a = card("ear.degrees.major.135");
    s.cards.b = card("ear.degrees.major.135");
    s.cards.c = card("ear.rhythm.echo");
    // read.bass.landmarks is learning but has no answered item yet, so there is nothing to repeat.
    const skills = practiceSkills(s, graph);
    expect(skills.map((x) => [x.nodeId, x.items])).toEqual([
      ["ear.degrees.major.135", 2],
      ["ear.rhythm.echo", 1],
    ]);
    expect(skills[0]).toMatchObject({ title: "Degrees 1, 3, 5", strand: "EAR" });
  });

  it("leaves out skills that are only available", () => {
    const s = state();
    s.nodes["ear.degrees.major.diatonic"] = { state: "available" };
    s.cards.a = card("ear.degrees.major.diatonic");
    expect(practiceSkills(s, graph)).toEqual([]);
  });
});

describe("practiceSearch", () => {
  it("lists the chosen skills, or none for everything", () => {
    expect(practiceSearch(["read.bass.landmarks", "read.bass.steps"])).toBe(
      "?practice=1&skills=read.bass.landmarks%2Cread.bass.steps",
    );
    expect(practiceSearch([])).toBe("?practice=1");
    expect(practiceSearch(["a"], { mode: "away" })).toBe("?practice=1&skills=a&mode=away");
  });
});
