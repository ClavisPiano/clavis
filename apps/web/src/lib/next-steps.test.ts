import { loadGraph } from "@clavis/content";
import {
  createScheduler,
  itemId,
  LearnerStateService,
  MemoryEventStore,
  type LearnerState,
} from "@clavis/core";
import { describe, expect, it } from "vitest";
import {
  followUpSearch,
  keepGoingBudgetSec,
  nextSteps,
  startWouldBeEmpty,
  welcomeBackOffer,
} from "./next-steps";

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

  it("never carries a welcome-back review into a follow-up session", () => {
    for (const kind of ["practice", "learn"] as const) {
      const out = new URLSearchParams(followUpSearch(q("welcome=1&input=fake"), kind, 60));
      expect(out.get("welcome")).toBeNull();
      expect(out.get(kind)).toBe("1");
    }
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

  it("a plain Start session is not empty for a new learner", async () => {
    expect(startWouldBeEmpty({ ...base, state: await emptyState() })).toBe(false);
  });
});

describe("welcomeBackOffer", () => {
  const graph = loadGraph();
  const now = Date.UTC(2026, 9, 12, 10); // Monday 2026-10-12
  const DAY = 86_400_000;
  const nodeId = "ear.degrees.major.135";
  const base = { graph, now, tzOffsetMin: 0, budgetSec: 720 } as const;

  async function emptyState() {
    const service = new LearnerStateService({
      store: new MemoryEventStore(),
      ctx: { graph, scheduler: createScheduler() },
    });
    await service.load();
    return service.state;
  }

  /** A learner with one due card in a learning node, last practised `daysAgo` days before `now`. */
  async function learner(daysAgo: number, withCard = true): Promise<LearnerState> {
    const state = await emptyState();
    const last = new Date(now - daysAgo * DAY).toISOString().slice(0, 10);
    return {
      ...state,
      nodes: { ...state.nodes, [nodeId]: { state: "learning" } },
      cards: withCard
        ? {
            [itemId(nodeId, { degree: 1 })]: {
              nodeId,
              card: {
                due: now - DAY,
                stability: 3,
                difficulty: 5,
                elapsedDays: daysAgo,
                scheduledDays: 3,
                reps: 3,
                lapses: 0,
                state: "review",
                lastReview: now - daysAgo * DAY,
              },
              lastAttemptAt: now - daysAgo * DAY,
              reps: 3,
            },
          }
        : {},
      daily: {
        [last]: {
          newItems: 0,
          nodesIntroduced: 0,
          sessions: 1,
          practiceSec: 300,
          mode: { instrument: 1, away: 0 },
        },
      },
    };
  }

  it("offers a half-length review after three or more missed days", async () => {
    const offer = welcomeBackOffer({ ...base, state: await learner(5) });
    expect(offer).toEqual({ missed: 4, sec: 360 });
    expect(welcomeBackOffer({ ...base, state: await learner(4) })?.missed).toBe(3);
  });

  it("scales with the session length setting", async () => {
    expect(welcomeBackOffer({ ...base, budgetSec: 1200, state: await learner(5) })?.sec).toBe(600);
  });

  it("does not offer it for fewer missed days, a new learner, or one who practised today", async () => {
    expect(welcomeBackOffer({ ...base, state: await learner(3) })).toBeUndefined();
    expect(welcomeBackOffer({ ...base, state: await learner(1) })).toBeUndefined();
    expect(welcomeBackOffer({ ...base, state: await emptyState() })).toBeUndefined();
    expect(welcomeBackOffer({ ...base, state: await learner(0) })).toBeUndefined();
  });

  it("does not offer a review when nothing is due, because the session would be empty", async () => {
    expect(welcomeBackOffer({ ...base, state: await learner(5, false) })).toBeUndefined();
  });
});
