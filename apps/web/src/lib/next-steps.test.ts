import { loadGraph } from "@clavis/content";
import { createScheduler, LearnerStateService, MemoryEventStore } from "@clavis/core";
import { describe, expect, it } from "vitest";
import { followUpSearch, keepGoingBudgetSec, nextSteps } from "./next-steps";

describe("keepGoingBudgetSec", () => {
  it.each([
    [720, 120, 600],
    [720, 0, 720],
    [720, 700, 720],
    [720, 661, 720],
    [720, 660, 60],
    [90, 30, 60],
    [90, 90, 90],
    [90, 400, 90],
  ])("budget %i s, used %i s gives %i s", (budget, used, want) => {
    expect(keepGoingBudgetSec(budget, used)).toBe(want);
  });

  it("rounds the remainder to 30 s and stays within the budget param limits", () => {
    expect(keepGoingBudgetSec(720, 100)).toBe(630);
    expect(keepGoingBudgetSec(10_000, 0)).toBe(3600);
    expect(keepGoingBudgetSec(10, 0)).toBe(30);
  });
});

describe("followUpSearch", () => {
  const q = (s: string) => new URLSearchParams(s);

  it("keeps input and audio params and sets practice with its budget", () => {
    const out = new URLSearchParams(
      followUpSearch(q("input=fake&budget=90&audio=silent"), "practice", 60),
    );
    expect(Object.fromEntries(out)).toEqual({
      input: "fake",
      audio: "silent",
      budget: "60",
      practice: "1",
    });
  });

  it("learn keeps the budget of a regular session but not of a practice round", () => {
    expect(
      new URLSearchParams(followUpSearch(q("budget=90&input=fake"), "learn")).get("budget"),
    ).toBe("90");
    const fromPractice = new URLSearchParams(
      followUpSearch(q("practice=1&budget=60&input=fake"), "learn"),
    );
    expect(fromPractice.get("budget")).toBeNull();
    expect(fromPractice.get("practice")).toBeNull();
    expect(fromPractice.get("learn")).toBe("1");
  });

  it("keeps Away mode", () => {
    expect(new URLSearchParams(followUpSearch(q("mode=away"), "practice", 120)).get("mode")).toBe(
      "away",
    );
  });
});

describe("nextSteps", () => {
  const graph = loadGraph();
  const base = {
    graph,
    now: Date.UTC(2026, 9, 12, 10),
    tzOffsetMin: 0,
    mode: "instrument",
    budgetSec: 720,
    elapsedSec: 120,
  } as const;

  async function emptyState() {
    const service = new LearnerStateService({
      store: new MemoryEventStore(),
      ctx: { graph, scheduler: createScheduler() },
    });
    await service.load();
    return service.state;
  }

  it("offers nothing to keep going on for a learner with no started items", async () => {
    const steps = nextSteps({ ...base, state: await emptyState() });
    expect(steps.keepGoing).toBe(false);
    // Something can still be introduced.
    expect(steps.learn).toBe(true);
    expect(steps.keepGoingSec).toBe(600);
  });
});
