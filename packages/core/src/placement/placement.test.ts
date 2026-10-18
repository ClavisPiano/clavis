import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { V1_GRAPH } from "../composer/fixtures/graph.js";
import type { SkillGraph, SkillNode } from "../graph/schema.js";
import { createRng } from "../random.js";
import { mergePlacement, placementResults } from "./evaluate.js";
import { nextPlacementStep, placementPlan } from "./plan.js";
import type { PlacementAttempt, PlacementPlan, PlacementState } from "./types.js";

const byId = (id: string): SkillNode => {
  const n = V1_GRAPH.nodes.find((x) => x.id === id);
  if (!n) throw new Error(id);
  return n;
};
const landmarks = byId("read.bass.landmarks");
const GRAPH: SkillGraph = {
  ...V1_GRAPH,
  nodes: [
    ...V1_GRAPH.nodes,
    {
      ...landmarks,
      id: "read.bass.steps",
      prerequisites: ["read.bass.landmarks"],
      params: {
        clef: "bass",
        anchors: ["C2", "F3", "C4", "G2"],
        maxOffsetSteps: 1,
      },
    },
    {
      ...landmarks,
      id: "read.bass.skips",
      prerequisites: ["read.bass.steps"],
      params: {
        clef: "bass",
        anchors: ["C2", "F3", "C4", "G2"],
        maxOffsetSteps: 2,
        fullRange: ["C2", "E4"],
      },
    },
    {
      ...byId("hands.lh.triads.root"),
      id: "hands.coord.basic",
      prerequisites: ["hands.lh.triads.root"],
      itemGenerators: ["coordTask"],
      params: { rh: "melody", lh: "block", chords: ["I", "IV", "V", "vi"] },
    },
  ],
};

const TARGET = 1500;
const EAR135 = "ear.degrees.major.135";
const DIA = "ear.degrees.major.diatonic";
const LM = "read.bass.landmarks";
const ST = "read.bass.steps";
const SK = "read.bass.skips";

/** n attempts on a node: `correct` of them right, all at `latency` (or per-index latencies). */
function att(
  nodeId: string,
  n: number,
  correct: number,
  latency: number | ((i: number) => number) = 500,
): PlacementAttempt[] {
  return Array.from({ length: n }, (_, i) => ({
    itemId: `${nodeId}#${String(i)}`,
    nodeId,
    correct: i < correct,
    latencyMs: typeof latency === "function" ? latency(i) : latency,
    targetLatencyMs: TARGET,
  }));
}

/** EAR runs before READ, so READ-only cases get a failed (cheap) EAR section in front. */
const results = (...parts: PlacementAttempt[][]) => {
  const all = parts.flat();
  const hasEar = all.some((a) => a.nodeId === EAR135);
  return placementResults(hasEar ? all : [...att(EAR135, 9, 0), ...all], GRAPH);
};

describe("EAR 1-3-5 thresholds (9 items)", () => {
  const cases: [string, number, number, PlacementState][] = [
    ["9 correct, fast", 9, 500, "mastered"],
    ["8 correct, median in target", 8, 500, "mastered"],
    ["8 correct, median over target", 8, 2000, "fluent"],
    ["7 correct, fast", 7, 500, "fluent"],
    ["6 correct, fast", 6, 500, "available"],
    ["0 correct", 0, 500, "available"],
  ];
  it.each(cases)("%s", (_n, correct, latency, expected) => {
    expect(results(att(EAR135, 9, correct, latency))[EAR135]).toBe(expected);
  });
  it("median exactly at target counts as within", () => {
    expect(results(att(EAR135, 9, 9, TARGET))[EAR135]).toBe("mastered");
  });
  it("one slow answer does not break the median", () => {
    expect(results(att(EAR135, 9, 9, (i) => (i === 0 ? 9000 : 500)))[EAR135]).toBe("mastered");
  });
  it("is incomplete (no entry) until all 9 are answered", () => {
    expect(placementResults(att(EAR135, 8, 8), GRAPH)).toEqual({});
  });
});

describe("EAR diatonic thresholds (8 items, n-1 / n-2)", () => {
  const ok = att(EAR135, 9, 9);
  const cases: [string, number, number, PlacementState][] = [
    ["8 correct, fast", 8, 500, "mastered"],
    ["7 correct, median in target", 7, 500, "mastered"],
    ["7 correct, median over target", 7, 2000, "fluent"],
    ["6 correct", 6, 500, "fluent"],
    ["5 correct", 5, 500, "available"],
  ];
  it.each(cases)("%s", (_n, correct, latency, expected) => {
    expect(results(ok, att(DIA, 8, correct, latency))[DIA]).toBe(expected);
  });
});

describe("READ thresholds", () => {
  it("landmarks table", () => {
    const cases: [string, PlacementAttempt[], PlacementState][] = [
      ["4/4 within target", att(LM, 4, 4), "mastered"],
      ["4/4 one over target", att(LM, 4, 4, (i) => (i === 0 ? 2000 : 500)), "fluent"],
      ["4/4 at target", att(LM, 4, 4, 1500), "mastered"],
      ["3/4", att(LM, 4, 3), "fluent"],
      ["3/4 slow", att(LM, 4, 3, 5000), "fluent"],
      ["2/4", att(LM, 4, 2), "available"],
    ];
    for (const [name, a, expected] of cases) {
      expect(results(a)[LM], name).toBe(expected);
    }
  });
  const lmOk = att(LM, 4, 4);
  it.each([
    ["3/3", 3, 500, "mastered"],
    ["3/3 one slow", 3, -1, "fluent"],
    ["2/3", 2, 500, "fluent"],
    ["1/3", 1, 500, "available"],
  ] as const)("steps %s", (_n, correct, latency, expected) => {
    const a = att(ST, 3, correct, (i) => (latency === -1 && i === 1 ? 4000 : 500));
    expect(results(lmOk, a)[ST]).toBe(expected);
  });
  it.each([
    ["3/3", 3, "mastered"],
    ["2/3", 2, "fluent"],
    ["1/3", 1, "available"],
  ] as const)("skips %s", (_n, correct, expected) => {
    expect(results(lmOk, att(ST, 3, 3), att(SK, 3, correct))[SK]).toBe(expected);
  });
});

describe("prerequisite capping and early stop", () => {
  it("caps a node at its prerequisite placement", () => {
    // Landmarks fluent, steps would be mastered: capped to fluent.
    const r = results(att(LM, 4, 3), att(ST, 3, 3), att(SK, 3, 3));
    expect(r).toEqual({
      [EAR135]: "available",
      [LM]: "fluent",
      [ST]: "fluent",
      [SK]: "fluent",
    });
  });
  it("READ stops at the first available; later nodes get no entry", () => {
    const r = results(att(LM, 4, 2), att(ST, 3, 3), att(SK, 3, 3));
    expect(r).toEqual({ [EAR135]: "available", [LM]: "available" });
  });
  it("diatonic is not placed unless 1-3-5 is mastered", () => {
    expect(results(att(EAR135, 9, 7), att(DIA, 8, 8))).toEqual({ [EAR135]: "fluent" });
    expect(results(att(EAR135, 9, 5), att(DIA, 8, 8))).toEqual({ [EAR135]: "available" });
  });
  it("EAR stopping does not stop READ", () => {
    const r = results(att(EAR135, 9, 3), att(LM, 4, 4));
    expect(r).toEqual({ [EAR135]: "available", [LM]: "mastered" });
  });
  it("nextPlacementStep skips diatonic after a fluent 1-3-5 and goes to READ", () => {
    const plan = placementPlan(GRAPH, createRng(1));
    const step = nextPlacementStep(plan, att(EAR135, 9, 7));
    expect(step.kind).toBe("item");
    if (step.kind === "item") {
      expect(step.item.stageId).toBe("read.landmarks");
      expect(step.stageStart).toBe(true);
    }
  });
  it("nextPlacementStep runs diatonic after a mastered 1-3-5", () => {
    const plan = placementPlan(GRAPH, createRng(1));
    const step = nextPlacementStep(plan, att(EAR135, 9, 9));
    expect(step.kind === "item" && step.item.stageId).toBe("ear.diatonic");
  });
  it("is done after both sections stop early, listing skipped stages", () => {
    const plan = placementPlan(GRAPH, createRng(1));
    const step = nextPlacementStep(plan, [...att(EAR135, 9, 2), ...att(LM, 4, 1)]);
    expect(step.kind).toBe("done");
    if (step.kind === "done") {
      expect(step.skippedStageIds).toEqual(["ear.diatonic", "read.steps", "read.skips"]);
      expect(step.completed.map((o) => o.state)).toEqual(["available", "available"]);
    }
  });
});

describe("mergePlacement (R5, raise only)", () => {
  const states: PlacementState[] = ["available", "fluent", "mastered"];
  it("returns the higher state", () => {
    for (const [i, a] of states.entries()) {
      for (const [j, b] of states.entries()) {
        expect(mergePlacement(a, b)).toBe(states[Math.max(i, j)]);
      }
    }
    expect(mergePlacement(undefined, "fluent")).toBe("fluent");
  });
});

/** Drive the whole flow with an answer function, as T3.16 will. */
function run(plan: PlacementPlan, answer: (i: number) => { correct: boolean; latencyMs: number }) {
  const attempts: PlacementAttempt[] = [];
  for (let i = 0; i < 100; i++) {
    const step = nextPlacementStep(plan, attempts);
    if (step.kind === "done") return attempts;
    attempts.push({
      itemId: step.item.itemId,
      nodeId: step.item.nodeId,
      targetLatencyMs: TARGET,
      ...answer(i),
    });
  }
  throw new Error("flow did not terminate");
}

describe("properties", () => {
  const plan = placementPlan(GRAPH, createRng(7));
  const order = { available: 0, fluent: 1, mastered: 2 } as const;
  it("never above a prerequisite, only reached nodes placed, always terminates", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ correct: fc.boolean(), latencyMs: fc.integer({ min: 100, max: 4000 }) }),
          {
            minLength: 40,
            maxLength: 40,
          },
        ),
        (outcomes) => {
          const attempts = run(plan, (i) => outcomes[i % outcomes.length] as never);
          const r = placementResults(attempts, GRAPH);
          expect(attempts.length).toBeLessThanOrEqual(9 + 8 + 4 + 3 + 3);
          for (const [id, state] of Object.entries(r)) {
            const node = GRAPH.nodes.find((n) => n.id === id);
            for (const p of node?.prerequisites ?? []) {
              const ps = r[p];
              if (ps !== undefined) expect(order[state]).toBeLessThanOrEqual(order[ps]);
            }
          }
          // The section stops at the first available.
          if (r[LM] === "available") expect(r[ST]).toBeUndefined();
          if (r[ST] === "available") expect(r[SK]).toBeUndefined();
          if (r[EAR135] !== "mastered") expect(r[DIA]).toBeUndefined();
        },
      ),
    );
  });
});

describe("placementPlan", () => {
  it("has the R19 shape for any seed", () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const plan = placementPlan(GRAPH, createRng(seed));
        expect(plan.stages.map((s) => [s.id, s.items.length])).toEqual([
          ["ear.135", 9],
          ["ear.diatonic", 8],
          ["read.landmarks", 4],
          ["read.steps", 3],
          ["read.skips", 3],
        ]);
        const degrees = (id: string) =>
          plan.stages
            .find((s) => s.id === id)
            ?.items.map((i) => i.degree)
            .sort();
        expect(degrees("ear.135")).toEqual([1, 1, 1, 3, 3, 3, 5, 5, 5]);
        expect(degrees("ear.diatonic")).toEqual([2, 2, 4, 4, 6, 6, 7, 7]);
        const pos = plan.stages.filter((s) => s.section === "READ").flatMap((s) => s.items);
        expect(new Set(pos.map((i) => i.pos)).size).toBe(10);
      }),
    );
  });
  it("is deterministic for a seed", () => {
    expect(placementPlan(GRAPH, createRng(3))).toEqual(placementPlan(GRAPH, createRng(3)));
  });
  it("golden plan for seed 42", () => {
    const plan = placementPlan(GRAPH, createRng(42));
    expect(plan.stages.map((s) => ({ id: s.id, ids: s.items.map((i) => i.itemId) }))).toEqual(
      GOLDEN,
    );
  });
});

const E135 = "ear.degrees.major.135|degree=";
const EDIA = "ear.degrees.major.diatonic|degree=";
const GOLDEN: { id: string; ids: string[] }[] = [
  { id: "ear.135", ids: [3, 3, 1, 5, 1, 3, 5, 1, 5].map((d) => `${E135}${String(d)}`) },
  { id: "ear.diatonic", ids: [4, 7, 2, 6, 2, 4, 7, 6].map((d) => `${EDIA}${String(d)}`) },
  {
    id: "read.landmarks",
    ids: ["C2", "F3", "G2", "C4"].map((p) => `read.bass.landmarks|fam=A|pos=${p}`),
  },
  { id: "read.steps", ids: ["B3", "E3", "F2"].map((p) => `read.bass.steps|fam=A|pos=${p}`) },
  { id: "read.skips", ids: ["D3", "E4", "C3"].map((p) => `read.bass.skips|fam=A|pos=${p}`) },
];

describe("HANDS section (R27, MIDI only)", () => {
  const LH = "hands.lh.triads.root";
  const CO = "hands.coord.basic";
  /** EAR and READ stopped at their first stage, so HANDS comes next. */
  const earlyStops = [...att(EAR135, 9, 0), ...att(LM, 4, 0)];
  const handsPlan = placementPlan(GRAPH, createRng(1), { polyphonic: true });

  it("table: a correct item places its node at fluent, otherwise available", () => {
    const cases: [string, PlacementAttempt[], Record<string, PlacementState>][] = [
      ["both correct", [...att(LH, 1, 1), ...att(CO, 1, 1)], { [LH]: "fluent", [CO]: "fluent" }],
      [
        "chords correct, hands together wrong",
        [...att(LH, 1, 1), ...att(CO, 1, 0)],
        { [LH]: "fluent", [CO]: "available" },
      ],
      ["chords wrong: the second is not placed", att(LH, 1, 0), { [LH]: "available" }],
      [
        "chords wrong, a stray coordination attempt is ignored",
        [...att(LH, 1, 0), ...att(CO, 1, 1)],
        { [LH]: "available" },
      ],
      ["chords correct, coordination unanswered", att(LH, 1, 1), { [LH]: "fluent" }],
      // Latency plays no part: one item, right or wrong.
      [
        "correct but slow",
        [...att(LH, 1, 1, 60_000), ...att(CO, 1, 1, 60_000)],
        { [LH]: "fluent", [CO]: "fluent" },
      ],
    ];
    for (const [name, hands, expected] of cases) {
      expect(placementResults([...earlyStops, ...hands], GRAPH), name).toEqual({
        [EAR135]: "available",
        [LM]: "available",
        ...expected,
      });
    }
  });

  it("never places hands nodes above fluent, even when EAR and READ are mastered", () => {
    const all = [
      ...att(EAR135, 9, 9),
      ...att(DIA, 8, 8),
      ...att(LM, 4, 4),
      ...att(ST, 3, 3),
      ...att(SK, 3, 3),
      ...att(LH, 1, 1),
      ...att(CO, 1, 1),
    ];
    const r = placementResults(all, GRAPH);
    expect([r[LH], r[CO]]).toEqual(["fluent", "fluent"]);
  });

  it("is in the plan only with polyphonic input, after READ, one fixed item per stage", () => {
    for (const plan of [
      placementPlan(GRAPH, createRng(1)),
      placementPlan(GRAPH, createRng(1), { polyphonic: false }),
    ]) {
      expect(plan.stages.some((s) => s.section === "HANDS")).toBe(false);
    }
    expect(handsPlan.stages.map((s) => s.id)).toEqual([
      "ear.135",
      "ear.diatonic",
      "read.landmarks",
      "read.steps",
      "read.skips",
      "hands.lh",
      "hands.coord",
    ]);
    const hands = handsPlan.stages.filter((s) => s.section === "HANDS").flatMap((s) => s.items);
    expect(hands.map((i) => [i.generator, i.itemId])).toEqual([
      ["lhPattern", "hands.lh.triads.root|fam=A|prog=I-IV-V-I"],
      ["coordTask", "hands.coord.basic|fam=A|mel=1|prog=I-IV-V-I"],
    ]);
  });

  it("leaves EAR and READ unchanged for a seed", () => {
    const withHands = placementPlan(GRAPH, createRng(42), { polyphonic: true });
    expect(withHands.stages.slice(0, 5)).toEqual(placementPlan(GRAPH, createRng(42)).stages);
  });

  it("throws when a polyphonic plan's graph lacks a hands node", () => {
    expect(() => placementPlan(V1_GRAPH, createRng(1), { polyphonic: true })).toThrow();
  });

  it("nextPlacementStep: without HANDS the plan ends after READ", () => {
    const step = nextPlacementStep(placementPlan(GRAPH, createRng(1)), earlyStops);
    expect(step.kind).toBe("done");
    if (step.kind === "done") expect(step.skippedStageIds).not.toContain("hands.lh");
  });

  it("nextPlacementStep: HANDS runs after READ, even when EAR and READ stopped early", () => {
    const first = nextPlacementStep(handsPlan, earlyStops);
    expect(first.kind === "item" && [first.item.stageId, first.stageStart]).toEqual([
      "hands.lh",
      true,
    ]);
    const second = nextPlacementStep(handsPlan, [...earlyStops, ...att(LH, 1, 1)]);
    expect(second.kind === "item" && second.item.stageId).toBe("hands.coord");
    const done = nextPlacementStep(handsPlan, [...earlyStops, ...att(LH, 1, 1), ...att(CO, 1, 0)]);
    expect(done.kind).toBe("done");
  });

  it("nextPlacementStep: a wrong chord item skips the coordination item", () => {
    const step = nextPlacementStep(handsPlan, [...earlyStops, ...att(LH, 1, 0)]);
    expect(step.kind).toBe("done");
    if (step.kind === "done")
      expect(step.skippedStageIds).toEqual([
        "ear.diatonic",
        "read.steps",
        "read.skips",
        "hands.coord",
      ]);
  });

  it("property: terminates, and coordination is placed exactly when the chords are fluent", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ correct: fc.boolean(), latencyMs: fc.integer({ min: 100, max: 4000 }) }),
          { minLength: 40, maxLength: 40 },
        ),
        (outcomes) => {
          const attempts = run(handsPlan, (i) => outcomes[i % outcomes.length] as never);
          expect(attempts.length).toBeLessThanOrEqual(9 + 8 + 4 + 3 + 3 + 2);
          expect(attempts.filter((a) => a.nodeId === LH)).toHaveLength(1);
          const r = placementResults(attempts, GRAPH);
          if (r[LH] === "available") expect(r[CO]).toBeUndefined();
          else expect(r[CO]).toBeDefined();
          for (const id of [LH, CO]) expect(r[id]).not.toBe("mastered");
        },
      ),
    );
  });
});
