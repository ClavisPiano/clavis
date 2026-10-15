import { describe, expect, it } from "vitest";
import { composeSession } from "./compose.js";
import {
  CTX,
  D135,
  DIATONIC,
  NOW,
  learnerAtDailyCap,
  learnerWithDueCards,
  newLearner,
} from "./fixtures/learners.js";
import { HANDS_EAR, V1_GRAPH, withHandsDependentEar } from "./fixtures/graph.js";
import { initialState } from "../state/reduce.js";
import type { SessionPlan } from "./types.js";
import type { LearnerState } from "../state/types.js";

const base = { graph: V1_GRAPH, now: NOW, tzOffsetMin: 0, seed: 42 };

/** Compact, reviewable view of a plan. */
function summarise(plan: SessionPlan) {
  const line = (i: SessionPlan["blocks"]["ear"][number]) =>
    `${i.isNew ? "NEW" : "due"} ${i.generator} ${i.itemId.replace(/^ear\./, "")} ${String(i.estimatedSec)}s`;
  return {
    key: `${plan.key.tonic} ${plan.key.mode}`,
    mode: plan.mode,
    budgetSec: plan.budgetSec,
    estimatedSec: plan.estimatedSec,
    orient: plan.orient,
    introductions: plan.introductions,
    diagnostics: plan.diagnostics,
    ear: plan.blocks.ear.map(line),
    read: plan.blocks.read.map(line),
    apply: plan.blocks.apply,
  };
}

const compose = (
  state: LearnerState,
  o: { mode?: "instrument" | "away"; budgetSec?: number } = {},
) =>
  composeSession({
    ...base,
    state,
    mode: o.mode ?? "instrument",
    ...(o.budgetSec ? { budgetSec: o.budgetSec } : {}),
  });

describe("composeSession goldens", () => {
  it("brand new learner introduces the first degree node", () => {
    expect(summarise(compose(newLearner()))).toMatchInlineSnapshot(`
      {
        "apply": null,
        "budgetSec": 720,
        "diagnostics": {
          "dueCount": 0,
          "newAllowance": 5,
          "notes": [
            "apply has no content",
            "read has no content",
          ],
          "reallocatedSec": 432,
        },
        "ear": [
          "NEW degreeSing degrees.major.135|degree=1 8s",
          "NEW degreeId degrees.major.135|degree=3 6s",
          "NEW degreeSing degrees.major.135|degree=5 8s",
        ],
        "estimatedSec": 94,
        "introductions": [
          "ear.degrees.major.135",
        ],
        "key": "C major",
        "mode": "instrument",
        "orient": {
          "estimatedSec": 72,
          "includeScale": true,
        },
        "read": [],
      }
    `);
  });

  it("learner with due cards and a learning node", () => {
    const state = learnerWithDueCards();
    expect(state.nodes[DIATONIC]?.state).toBe("learning");
    expect(state.nodes[D135]?.state).toBe("mastered");
    expect(summarise(compose(state))).toMatchInlineSnapshot(`
      {
        "apply": null,
        "budgetSec": 720,
        "diagnostics": {
          "dueCount": 6,
          "newAllowance": 5,
          "notes": [
            "apply has no content",
            "read has no content",
          ],
          "reallocatedSec": 432,
        },
        "ear": [
          "due degreeSing degrees.major.diatonic|degree=1 8s",
          "NEW degreeId degrees.major.diatonic|degree=4 5s",
          "NEW degreeSing degrees.major.diatonic|degree=5 8s",
          "due degreeId degrees.major.diatonic|degree=2 5s",
          "due degreeSing degrees.major.diatonic|degree=3 8s",
          "due degreeSing degrees.major.135|degree=1 8s",
          "NEW degreeId degrees.major.diatonic|degree=6 5s",
          "due degreeId degrees.major.135|degree=3 5s",
          "NEW degreeSing degrees.major.diatonic|degree=7 8s",
          "due degreeSing degrees.major.135|degree=5 8s",
        ],
        "estimatedSec": 140,
        "introductions": [],
        "key": "G major",
        "mode": "instrument",
        "orient": {
          "estimatedSec": 72,
          "includeScale": true,
        },
        "read": [],
      }
    `);
  });

  it("learner who hit the daily new-item cap gets no new items or introductions", () => {
    const state = learnerAtDailyCap();
    expect(summarise(compose(state))).toMatchInlineSnapshot(`
      {
        "apply": null,
        "budgetSec": 720,
        "diagnostics": {
          "dueCount": 8,
          "newAllowance": 0,
          "notes": [
            "apply has no content",
            "read has no content",
            "orient skipped: not the first session of the day",
          ],
          "reallocatedSec": 432,
        },
        "ear": [
          "due degreeSing degrees.major.135|degree=1 8s",
          "due degreeId degrees.major.135|degree=3 5s",
          "due degreeSing degrees.major.135|degree=5 8s",
          "due degreeSing degrees.major.diatonic|degree=1 8s",
          "due degreeId degrees.major.diatonic|degree=2 5s",
          "due degreeSing degrees.major.diatonic|degree=3 8s",
          "due degreeId degrees.major.diatonic|degree=4 5s",
          "due degreeSing degrees.major.diatonic|degree=5 8s",
        ],
        "estimatedSec": 55,
        "introductions": [],
        "key": "C major",
        "mode": "instrument",
        "orient": null,
        "read": [],
      }
    `);
  });

  it("away session for a learner with due cards", () => {
    expect(summarise(compose(learnerWithDueCards(), { mode: "away" }))).toMatchInlineSnapshot(`
      {
        "apply": null,
        "budgetSec": 300,
        "diagnostics": {
          "dueCount": 6,
          "newAllowance": 5,
          "notes": [
            "away: ear only, orient skipped",
          ],
          "reallocatedSec": 0,
        },
        "ear": [
          "due degreeSing degrees.major.diatonic|degree=1 8s",
          "NEW degreeId degrees.major.diatonic|degree=4 5s",
          "NEW degreeSing degrees.major.diatonic|degree=5 8s",
          "due degreeId degrees.major.diatonic|degree=2 5s",
          "due degreeSing degrees.major.diatonic|degree=3 8s",
          "due degreeSing degrees.major.135|degree=1 8s",
          "NEW degreeId degrees.major.diatonic|degree=6 5s",
          "due degreeId degrees.major.135|degree=3 5s",
          "NEW degreeSing degrees.major.diatonic|degree=7 8s",
          "due degreeSing degrees.major.135|degree=5 8s",
        ],
        "estimatedSec": 68,
        "introductions": [],
        "key": "G major",
        "mode": "away",
        "orient": null,
        "read": [],
      }
    `);
  });

  it("away session for a brand new learner introduces an eligible node", () => {
    expect(summarise(compose(newLearner(), { mode: "away" }))).toMatchInlineSnapshot(`
      {
        "apply": null,
        "budgetSec": 300,
        "diagnostics": {
          "dueCount": 0,
          "newAllowance": 5,
          "notes": [
            "away: ear only, orient skipped",
          ],
          "reallocatedSec": 0,
        },
        "ear": [
          "NEW degreeSing degrees.major.135|degree=1 8s",
          "NEW degreeId degrees.major.135|degree=3 6s",
          "NEW degreeSing degrees.major.135|degree=5 8s",
        ],
        "estimatedSec": 22,
        "introductions": [
          "ear.degrees.major.135",
        ],
        "key": "C major",
        "mode": "away",
        "orient": null,
        "read": [],
      }
    `);
  });

  it("5 minute instrument session", () => {
    expect(summarise(compose(learnerWithDueCards(), { budgetSec: 300 }))).toMatchInlineSnapshot(`
      {
        "apply": null,
        "budgetSec": 300,
        "diagnostics": {
          "dueCount": 6,
          "newAllowance": 5,
          "notes": [
            "time pressure: apply dropped",
            "read has no content",
          ],
          "reallocatedSec": 180,
        },
        "ear": [
          "due degreeSing degrees.major.diatonic|degree=1 8s",
          "NEW degreeId degrees.major.diatonic|degree=4 5s",
          "NEW degreeSing degrees.major.diatonic|degree=5 8s",
          "due degreeId degrees.major.diatonic|degree=2 5s",
          "due degreeSing degrees.major.diatonic|degree=3 8s",
          "due degreeSing degrees.major.135|degree=1 8s",
          "NEW degreeId degrees.major.diatonic|degree=6 5s",
          "due degreeId degrees.major.135|degree=3 5s",
          "NEW degreeSing degrees.major.diatonic|degree=7 8s",
          "due degreeSing degrees.major.135|degree=5 8s",
        ],
        "estimatedSec": 98,
        "introductions": [],
        "key": "G major",
        "mode": "instrument",
        "orient": {
          "estimatedSec": 30,
          "includeScale": false,
        },
        "read": [],
      }
    `);
  });
});

describe("composeSession rules", () => {
  it("introduces a HANDS-dependent node at the desk but never in Away mode", () => {
    const graph = withHandsDependentEar();
    const state = initialState({ graph, scheduler: CTX.scheduler });
    for (const n of graph.nodes) state.nodes[n.id] = { state: "locked" };
    state.nodes[HANDS_EAR] = { state: "available" };
    const at = (mode: "instrument" | "away") =>
      composeSession({ ...base, graph, state, mode }).introductions;
    expect(at("instrument")).toEqual([HANDS_EAR]);
    expect(at("away")).toEqual([]);
    // An eligible alternative wins in Away mode even though it has more prerequisites.
    state.nodes["ear.cells.major.2-4"] = { state: "available" };
    expect(at("away")).toEqual(["ear.cells.major.2-4"]);
  });

  it("does not introduce a second node while one is learning", () => {
    const state = learnerWithDueCards();
    state.nodes["ear.rhythm.echo"] = { state: "available" };
    expect(compose(state).introductions).toEqual([]);
  });

  it("introduces a pitch skill before rhythm, though rhythm has no prerequisites", () => {
    const state = newLearner();
    state.nodes[D135] = { state: "mastered" };
    state.nodes[DIATONIC] = { state: "available" };
    state.nodes["ear.rhythm.echo"] = { state: "available" };
    expect(compose(state).introductions).toEqual([DIATONIC]);
  });

  it("introduces rhythm when no pitch skill is waiting", () => {
    const state = newLearner();
    state.nodes[D135] = { state: "mastered" };
    state.nodes["ear.rhythm.echo"] = { state: "available" };
    expect(compose(state).introductions).toEqual(["ear.rhythm.echo"]);
  });

  it("warms up with the key of the day only before the first finished session of the day", () => {
    // This learner finished a session earlier today; the others have not.
    expect(compose(learnerAtDailyCap()).orient).toBeNull();
    expect(compose(newLearner()).orient).not.toBeNull();
    expect(compose(learnerWithDueCards()).orient).not.toBeNull();
    // Practice never warms up, even for a learner with nothing done today.
    const practice = composeSession({
      ...base,
      state: newLearner(),
      mode: "instrument",
      practice: true,
    });
    expect(practice.orient).toBeNull();
  });

  it("still warms up when the earlier session ended before its first exercise", () => {
    const state = learnerAtDailyCap();
    for (const x of Object.values(state.sessions)) x.itemsPresented = 0;
    expect(compose(state).orient).not.toBeNull();
  });

  it("gives the warm-up time to the exercises when it is skipped", () => {
    const withOrient = compose(newLearner(), { budgetSec: 600 });
    const without = compose(learnerAtDailyCap(), { budgetSec: 600 });
    expect(withOrient.orient?.estimatedSec).toBeGreaterThan(0);
    expect(without.orient).toBeNull();
    expect(without.diagnostics.notes).toContain("orient skipped: not the first session of the day");
  });

  it("practises only the chosen skills", () => {
    const state = learnerWithDueCards();
    state.nodes["ear.rhythm.echo"] = { state: "learning" };
    const all = composeSession({ ...base, state, mode: "instrument", practice: true });
    const only = composeSession({
      ...base,
      state,
      mode: "instrument",
      practice: true,
      skills: [D135],
    });
    const nodes = (p: SessionPlan): string[] => [...new Set(p.blocks.ear.map((i) => i.nodeId))];
    expect(nodes(only)).toEqual([D135]);
    expect(nodes(all).length).toBeGreaterThanOrEqual(nodes(only).length);
  });

  it("takes the default budget from settings, then the mode default", () => {
    const s = learnerWithDueCards();
    expect(compose(s).budgetSec).toBe(720);
    expect(compose(s, { mode: "away" }).budgetSec).toBe(300);
    s.settings.budgetSec = 600;
    s.settings.awayBudgetSec = 240;
    expect(compose(s).budgetSec).toBe(600);
    expect(compose(s, { mode: "away" }).budgetSec).toBe(240);
    expect(compose(s, { budgetSec: 900 }).budgetSec).toBe(900);
  });

  it("rejects a non-positive budget", () => {
    expect(() => compose(newLearner(), { budgetSec: -5 })).toThrow(RangeError);
  });

  it("is deterministic for a seed", () => {
    const s = learnerWithDueCards();
    expect(compose(s)).toEqual(compose(s));
  });
});
