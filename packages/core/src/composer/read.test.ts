import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { NodeState } from "../graph/schema.js";
import { openFamilies } from "../items/family.js";
import { itemId } from "../items/ids.js";
import { learnerDay } from "../learning/day.js";
import { newItemAllowance } from "../scheduler/new-items.js";
import type { LearnerState } from "../state/types.js";
import { keyFamily } from "../theory/keys.js";
import { at } from "../theory/util.js";
import { composeSession } from "./compose.js";
import { D135, DIATONIC, NOW } from "./fixtures/learners.js";
import {
  LANDMARKS,
  READ_GRAPH,
  RHYTHM,
  STEPS,
  STUB_READ_GENERATORS,
  readLearner,
} from "./fixtures/read.js";
import { V1_GRAPH } from "./fixtures/graph.js";
import { typeKey } from "./interleave.js";
import type { PlannedItem, SessionPlan } from "./types.js";
import { GENERATORS } from "../items/registry.js";

const DAY = 86_400_000;
const generators = { ...GENERATORS, ...STUB_READ_GENERATORS };
const base = { graph: READ_GRAPH, now: NOW, tzOffsetMin: 0, seed: 42, generators };

const compose = (
  state: LearnerState,
  o: { mode?: "instrument" | "away"; budgetSec?: number; seed?: number } = {},
) =>
  composeSession({
    ...base,
    state,
    mode: o.mode ?? "instrument",
    ...(o.budgetSec ? { budgetSec: o.budgetSec } : {}),
    ...(o.seed !== undefined ? { seed: o.seed } : {}),
  });

function summarise(plan: SessionPlan) {
  const line = (i: PlannedItem) =>
    [
      i.isNew ? "NEW" : "due",
      i.generator,
      i.itemId.replace(/^(ear|read)\./, ""),
      i.key ? `in ${i.key.tonic} ${i.key.mode}` : "",
      `${String(i.estimatedSec)}s`,
    ]
      .filter((x) => x !== "")
      .join(" ");
  return {
    key: `${plan.key.tonic} ${plan.key.mode}`,
    mode: plan.mode,
    budgetSec: plan.budgetSec,
    orient: plan.orient,
    introductions: plan.introductions,
    introductionKeyFamilies: plan.introductionKeyFamilies,
    newAllowance: plan.diagnostics.newAllowance,
    notes: plan.diagnostics.notes,
    ear: plan.blocks.ear.map(line),
    read: plan.blocks.read.map(line),
  };
}

const pos = (fam: "A" | "B" | "C", p: string) => ({ fam, pos: p });
const POS = ["C2", "F3", "C4", "G2"];

describe("composeSession with READ goldens", () => {
  it("learner with a READ node learning", () => {
    const state = readLearner({
      nodes: {
        [D135]: "mastered",
        [DIATONIC]: { state: "learning", introducedAt: NOW - 6 * DAY },
        [LANDMARKS]: {
          state: "learning",
          byFamily: { A: "learning" },
          introducedAt: NOW - 4 * DAY,
        },
      },
      cards: [
        { nodeId: D135, params: { degree: 1 }, dueInDays: -2 },
        { nodeId: D135, params: { degree: 3 }, dueInDays: -1 },
        { nodeId: LANDMARKS, params: pos("A", "C2"), dueInDays: -3 },
        { nodeId: LANDMARKS, params: pos("A", "F3"), dueInDays: -1 },
      ],
    });
    expect(summarise(compose(state))).toMatchInlineSnapshot(`
      {
        "budgetSec": 720,
        "ear": [
          "NEW degreeSing degrees.major.diatonic|degree=1 8s",
          "due degreeSing degrees.major.135|degree=1 8s",
          "NEW degreeId degrees.major.diatonic|degree=2 6s",
          "due degreeId degrees.major.135|degree=3 6s",
          "NEW degreeSing degrees.major.diatonic|degree=3 8s",
        ],
        "introductionKeyFamilies": {},
        "introductions": [],
        "key": "C major",
        "mode": "instrument",
        "newAllowance": 5,
        "notes": [
          "apply has no content",
        ],
        "orient": {
          "estimatedSec": 72,
          "includeScale": true,
        },
        "read": [
          "NEW bassNoteRead bass.landmarks|fam=A|pos=C4 in C major 5s",
          "due bassNoteRead bass.landmarks|fam=A|pos=C2 in C major 5s",
          "due bassNoteRead bass.landmarks|fam=A|pos=F3 in C major 5s",
          "NEW bassNoteRead bass.landmarks|fam=A|pos=G2 in C major 5s",
        ],
      }
    `);
  });

  it("opens family B for READ once A is mastered", () => {
    const state = readLearner({
      nodes: {
        [D135]: "mastered",
        [DIATONIC]: "mastered",
        [LANDMARKS]: {
          state: "learning",
          byFamily: { A: "mastered" },
          introducedAt: NOW - 20 * DAY,
        },
      },
      cards: POS.map((p) => ({ nodeId: LANDMARKS, params: pos("A", p), dueInDays: -1 })),
    });
    const plan = compose(state);
    expect(summarise(plan)).toMatchInlineSnapshot(`
      {
        "budgetSec": 720,
        "ear": [
          "NEW degreeSing degrees.major.135|degree=1 8s",
          "NEW degreeId degrees.major.135|degree=3 6s",
          "NEW degreeSing degrees.major.135|degree=5 8s",
        ],
        "introductionKeyFamilies": {},
        "introductions": [],
        "key": "C major",
        "mode": "instrument",
        "newAllowance": 5,
        "notes": [
          "apply has no content",
        ],
        "orient": {
          "estimatedSec": 72,
          "includeScale": true,
        },
        "read": [
          "NEW bassNoteRead bass.landmarks|fam=B|pos=C2 in Eb major 5s",
          "due bassNoteRead bass.landmarks|fam=A|pos=C2 in C major 5s",
          "due bassNoteRead bass.landmarks|fam=A|pos=C4 in C major 5s",
          "due bassNoteRead bass.landmarks|fam=A|pos=F3 in C major 5s",
          "NEW bassNoteRead bass.landmarks|fam=B|pos=F3 in D major 5s",
          "due bassNoteRead bass.landmarks|fam=A|pos=G2 in C major 5s",
        ],
      }
    `);
    const fresh = plan.blocks.read.filter((i) => i.isNew);
    expect(fresh.length).toBeGreaterThan(0);
    for (const i of fresh) expect(i.fam).toBe("B");
  });

  it("uses C major only for family A while bass landmarks are below fluent", () => {
    const history = { day: learnerDay(NOW - DAY, 0), key: { tonic: "C", mode: "major" } } as const;
    const mk = (landmarks: NodeState) => {
      const state = readLearner({
        nodes: {
          [D135]: "mastered",
          [DIATONIC]: "mastered",
          [LANDMARKS]: {
            state: landmarks,
            byFamily: { A: landmarks },
            introducedAt: NOW - 9 * DAY,
          },
        },
      });
      state.keyOfDayHistory.push({ day: history.day, key: { ...history.key } });
      return state;
    };
    const learning = compose(mk("learning"));
    expect(learning.key).toEqual({ tonic: "G", mode: "major" });
    expect(summarise(learning)).toMatchInlineSnapshot(`
      {
        "budgetSec": 720,
        "ear": [
          "NEW degreeSing degrees.major.135|degree=1 8s",
          "NEW degreeId degrees.major.135|degree=3 6s",
          "NEW degreeSing degrees.major.135|degree=5 8s",
        ],
        "introductionKeyFamilies": {},
        "introductions": [],
        "key": "G major",
        "mode": "instrument",
        "newAllowance": 5,
        "notes": [
          "apply has no content",
        ],
        "orient": {
          "estimatedSec": 72,
          "includeScale": true,
        },
        "read": [
          "NEW bassNoteRead bass.landmarks|fam=A|pos=F3 in C major 5s",
          "NEW bassNoteRead bass.landmarks|fam=A|pos=C2 in C major 5s",
        ],
      }
    `);
    for (const i of learning.blocks.read) expect(i.key).toEqual({ tonic: "C", mode: "major" });

    const fluent = compose(mk("fluent"));
    for (const i of fluent.blocks.read) expect(i.key).toEqual({ tonic: "G", mode: "major" });
  });

  it("Away with READ splits 60/40 and uses Away-eligible generators only", () => {
    const state = readLearner({
      nodes: {
        [D135]: "mastered",
        [DIATONIC]: { state: "learning", introducedAt: NOW - 6 * DAY },
        [LANDMARKS]: {
          state: "learning",
          byFamily: { A: "learning" },
          introducedAt: NOW - 4 * DAY,
        },
        [RHYTHM]: { state: "learning", introducedAt: NOW - 3 * DAY },
      },
      cards: [
        { nodeId: D135, params: { degree: 1 }, dueInDays: -2 },
        { nodeId: LANDMARKS, params: pos("A", "C2"), dueInDays: -3 },
        { nodeId: RHYTHM, params: { pattern: 1 }, dueInDays: -3 },
      ],
    });
    const plan = compose(state, { mode: "away" });
    expect(summarise(plan)).toMatchInlineSnapshot(`
      {
        "budgetSec": 300,
        "ear": [
          "NEW degreeSing degrees.major.diatonic|degree=1 8s",
          "due degreeSing degrees.major.135|degree=1 8s",
          "NEW degreeId degrees.major.diatonic|degree=2 6s",
          "NEW degreeSing degrees.major.diatonic|degree=3 8s",
        ],
        "introductionKeyFamilies": {},
        "introductions": [],
        "key": "C major",
        "mode": "away",
        "newAllowance": 5,
        "notes": [
          "away: ear 60%, read 40%, orient skipped",
        ],
        "orient": null,
        "read": [
          "due bassNoteRead bass.landmarks|fam=A|pos=C2 in C major 5s",
          "NEW bassNoteRead bass.landmarks|fam=A|pos=F3 in C major 5s",
          "NEW bassNoteRead bass.landmarks|fam=A|pos=C4 in C major 5s",
        ],
      }
    `);
    expect(plan.orient).toBeNull();
    expect(plan.blocks.read.length).toBeGreaterThan(0);
    for (const i of plan.blocks.read) expect(i.generator).toBe("bassNoteRead");
  });
});

describe("composeSession READ rules", () => {
  it("existing learners with no READ content are unaffected by the stub registry", () => {
    const state = readLearner({
      nodes: { [D135]: "mastered", [DIATONIC]: "learning" },
    });
    const withStubs = compose(state);
    const plain = composeSession({
      ...base,
      graph: V1_GRAPH,
      generators: GENERATORS,
      state,
      mode: "instrument",
    });
    expect(withStubs.blocks.ear).toEqual(plain.blocks.ear);
    expect(withStubs.blocks.read).toEqual([]);
  });

  it("does not enable READ nodes whose generators are not in the registry", () => {
    const state = readLearner({ nodes: { [D135]: "mastered", [LANDMARKS]: "learning" } });
    const earOnly = Object.fromEntries(
      Object.entries(GENERATORS).filter(([id]) => id !== "bassNoteRead" && id !== "rhythmRead"),
    );
    const plan = composeSession({ ...base, generators: earOnly, state, mode: "instrument" });
    expect(plan.blocks.read).toEqual([]);
  });

  it("a brand new learner ties and EAR introduces first", () => {
    const state = readLearner({ nodes: { [D135]: "available", [LANDMARKS]: "available" } });
    const plan = compose(state);
    expect(plan.introductions).toEqual([D135]);
    expect(plan.introductionKeyFamilies).toEqual({});
  });

  it("introduces a READ node with keyFamily A when EAR is learning and READ is not", () => {
    const state = readLearner({
      nodes: { [D135]: "learning", [LANDMARKS]: "available" },
    });
    const plan = compose(state);
    expect(plan.introductions).toEqual([LANDMARKS]);
    expect(plan.introductionKeyFamilies).toEqual({ [LANDMARKS]: "A" });
    expect(plan.blocks.read.some((i) => i.isNew && i.nodeId === LANDMARKS)).toBe(true);
    expect(plan.blocks.read.every((i) => i.fam === "A")).toBe(true);
  });

  it("the strand introduced less recently wins when both can introduce", () => {
    const nodes = (earAt: number, readAt: number) => ({
      [D135]: { state: "mastered" as const, introducedAt: earAt },
      [DIATONIC]: "available" as const,
      [LANDMARKS]: { state: "mastered" as const, introducedAt: readAt },
      [STEPS]: "available" as const,
    });
    const readOlder = compose(readLearner({ nodes: nodes(NOW - DAY, NOW - 9 * DAY) }));
    expect(readOlder.introductions).toEqual([STEPS]);
    const earOlder = compose(readLearner({ nodes: nodes(NOW - 9 * DAY, NOW - DAY) }));
    expect(earOlder.introductions).toEqual([DIATONIC]);
  });

  it("reserves half the allowance for READ when it has new candidates", () => {
    const state = readLearner({
      nodes: {
        [D135]: "mastered",
        [DIATONIC]: { state: "learning", introducedAt: NOW - 6 * DAY },
        [LANDMARKS]: {
          state: "learning",
          byFamily: { A: "learning" },
          introducedAt: NOW - 4 * DAY,
        },
      },
    });
    const plan = compose(state);
    const count = (b: PlannedItem[]) => b.filter((i) => i.isNew).length;
    expect(plan.diagnostics.newAllowance).toBe(5);
    expect(count(plan.blocks.ear)).toBe(3);
    expect(count(plan.blocks.read)).toBe(2);
  });

  it("generates the planned items with the stub generators", () => {
    const state = readLearner({
      nodes: {
        [D135]: "mastered",
        [LANDMARKS]: { state: "learning", byFamily: { A: "learning" } },
      },
    });
    const plan = compose(state);
    expect(plan.blocks.read.length).toBeGreaterThan(0);
    for (const i of plan.blocks.read) {
      const node = READ_GRAPH.nodes.find((n) => n.id === i.nodeId);
      const gen = generators[i.generator];
      expect(node && gen).toBeTruthy();
      if (!node || !gen || !i.key) throw new Error("expected key");
      const inst = gen.generate(node, i.params, {
        rng: { next: () => 0.5, int: () => 0, pick: (x) => at(x, 0) },
        preferredKey: i.key,
        voiceRange: { low: 36, high: 60 },
        mode: "instrument",
      });
      expect(inst.itemId).toBe(i.itemId);
      expect(inst.display).toBeDefined();
      expect(inst.expected.play?.kind).toBe("exactPitch");
    }
  });
});

const STATES: NodeState[] = ["locked", "available", "learning", "fluent", "mastered"];
const FAMS = ["A", "B", "C"] as const;

interface Scenario {
  state: LearnerState;
  mode: "instrument" | "away";
  budgetSec: number;
  seed: number;
}

const scenarioArb: fc.Arbitrary<Scenario> = fc
  .record({
    nodeStates: fc.array(fc.constantFrom<NodeState>(...STATES, "learning", "mastered"), {
      minLength: READ_GRAPH.nodes.length,
      maxLength: READ_GRAPH.nodes.length,
    }),
    famStates: fc.array(
      fc.array(fc.constantFrom<NodeState | undefined>(undefined, ...STATES), {
        minLength: 3,
        maxLength: 3,
      }),
      { minLength: READ_GRAPH.nodes.length, maxLength: READ_GRAPH.nodes.length },
    ),
    introducedDays: fc.array(fc.integer({ min: -1, max: 40 }), {
      minLength: READ_GRAPH.nodes.length,
      maxLength: READ_GRAPH.nodes.length,
    }),
    cardBits: fc.array(fc.integer({ min: 0, max: 0xfff }), {
      minLength: READ_GRAPH.nodes.length,
      maxLength: READ_GRAPH.nodes.length,
    }),
    dueDays: fc.array(fc.integer({ min: -20, max: 5 }), { minLength: 12, maxLength: 12 }),
    newToday: fc.integer({ min: 0, max: 6 }),
    mode: fc.constantFrom<"instrument" | "away">("instrument", "away"),
    budgetSec: fc.integer({ min: 30, max: 1500 }),
    seed: fc.integer({ min: 0, max: 0x7fffffff }),
    history: fc.constantFrom("none", "yesterday", "old"),
  })
  .map((r) => {
    const state = readLearner({ nodes: {}, newToday: r.newToday });
    READ_GRAPH.nodes.forEach((n, i) => {
      const nodeState = at(r.nodeStates, i);
      const fams = at(r.famStates, i);
      const byFamily: Partial<Record<"A" | "B" | "C", NodeState>> = {};
      FAMS.forEach((f, j) => {
        const s = fams[j];
        if (s !== undefined && n.keyDependent) byFamily[f] = s;
      });
      const days = at(r.introducedDays, i);
      state.nodes[n.id] = {
        state: nodeState,
        ...(n.keyDependent && Object.keys(byFamily).length > 0 ? { byFamily } : {}),
        ...(days >= 0 && nodeState !== "locked" && nodeState !== "available"
          ? { introducedAt: NOW - days * DAY }
          : {}),
      };
      if (nodeState === "locked" || nodeState === "available") return;
      const gen = generators[at(n.itemGenerators, 0)];
      if (!gen) return;
      gen.listItems(n).forEach((params, j) => {
        if (((at(r.cardBits, i) >> (j % 12)) & 1) === 0) return;
        state.cards[itemId(n.id, params)] = {
          nodeId: n.id,
          lastAttemptAt: NOW - 5 * DAY,
          reps: 3,
          card: {
            due: NOW + at(r.dueDays, (i + j) % 12) * DAY,
            stability: 5,
            difficulty: 5,
            elapsedDays: 1,
            scheduledDays: 1,
            reps: 3,
            lapses: 0,
            state: "review",
          },
        };
      });
    });
    const day = learnerDay(NOW - DAY, 0);
    if (r.history === "yesterday")
      state.keyOfDayHistory.push({ day, key: { tonic: "G", mode: "major" } });
    if (r.history === "old")
      state.keyOfDayHistory.push({
        day: learnerDay(NOW - 9 * DAY, 0),
        key: { tonic: "D", mode: "major" },
      });
    return { state, mode: r.mode, budgetSec: r.budgetSec, seed: r.seed };
  });

const run = (s: Scenario, o: { mode?: "instrument" | "away" } = {}) =>
  composeSession({
    ...base,
    state: s.state,
    mode: o.mode ?? s.mode,
    budgetSec: s.budgetSec,
    seed: s.seed,
  });
const all = (p: SessionPlan) => [...p.blocks.ear, ...p.blocks.read];
const NUM_RUNS = 150;

describe("composeSession READ invariants", () => {
  vi.setConfig({ testTimeout: 60_000 });
  it("never takes a new item from a closed family and keys items to their family", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const plan = run(s);
        const landmarks = s.state.nodes[LANDMARKS]?.state;
        const belowFluent = landmarks !== "fluent" && landmarks !== "mastered";
        for (const i of all(plan)) {
          if (i.fam === undefined) {
            expect(i.key).toBeUndefined();
            continue;
          }
          expect(i.key).toBeDefined();
          if (i.key) {
            expect(keyFamily(i.key)).toBe(i.fam);
            if (belowFluent && i.fam === "A") expect(["C", "A"]).toContain(i.key.tonic);
          }
          if (!i.isNew) continue;
          const rec = s.state.nodes[i.nodeId];
          const introducing = plan.introductions.includes(i.nodeId);
          const open = introducing ? ["A"] : rec ? openFamilies(rec) : [];
          expect(open).toContain(i.fam);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("introduces at most one node, carrying keyFamily A for key-dependent READ nodes", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const plan = run(s);
        expect(plan.introductions.length).toBeLessThanOrEqual(1);
        const [id] = plan.introductions;
        if (id !== undefined) {
          const node = READ_GRAPH.nodes.find((n) => n.id === id);
          expect(s.state.nodes[id]?.state).toBe("available");
          expect(plan.introductionKeyFamilies).toEqual(node?.keyDependent ? { [id]: "A" } : {});
        } else {
          expect(plan.introductionKeyFamilies).toEqual({});
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("respects the daily allowance across both strands and the READ reserve", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const plan = run(s);
        const today = learnerDay(NOW, 0);
        const allowance = newItemAllowance({
          introducedToday: s.state.daily[today]?.newItems ?? 0,
        });
        const earNew = plan.blocks.ear.filter((i) => i.isNew).length;
        const readNew = plan.blocks.read.filter((i) => i.isNew).length;
        expect(earNew + readNew).toBeLessThanOrEqual(allowance);
        if (readNew > 0) expect(earNew).toBeLessThanOrEqual(allowance - Math.floor(allowance / 2));
        for (const i of all(plan)) if (i.isNew) expect(s.state.cards[i.itemId]).toBeUndefined();
        expect(new Set(all(plan).map((i) => i.itemId)).size).toBe(all(plan).length);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("uses only Away-eligible generators in Away mode, with no Orient", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const plan = run(s, { mode: "away" });
        expect(plan.orient).toBeNull();
        for (const i of all(plan)) {
          const info = READ_GRAPH.generators.find((g) => g.id === i.generator);
          expect(info?.awayEligible).toBe(true);
          expect(info?.implemented).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("leaves no avoidable adjacent duplicates in either block", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const plan = run(s);
        for (const block of [plan.blocks.ear, plan.blocks.read]) {
          const counts = new Map<string, number>();
          for (const i of block) counts.set(typeKey(i), (counts.get(typeKey(i)) ?? 0) + 1);
          if (Math.max(0, ...counts.values()) > Math.ceil(block.length / 2)) continue;
          for (let i = 1; i < block.length; i++)
            expect(typeKey(at(block, i))).not.toBe(typeKey(at(block, i - 1)));
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("respects the budget to within one item and is deterministic", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const plan = run(s);
        const items = all(plan);
        const sum =
          items.reduce((a, i) => a + i.estimatedSec, 0) + (plan.orient?.estimatedSec ?? 0);
        expect(plan.estimatedSec).toBeCloseTo(sum, 9);
        const biggest = Math.max(0, ...items.map((i) => i.estimatedSec));
        expect(plan.estimatedSec).toBeLessThanOrEqual(plan.budgetSec + biggest);
        expect(run(s)).toEqual(plan);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
