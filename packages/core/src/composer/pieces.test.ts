import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { NodeState } from "../graph/schema.js";
import { itemId } from "../items/ids.js";
import { PIECE_EAR_NODE_ID } from "../items/piece-ear.js";
import { PIECES_NODE_ID } from "../items/piece-line.js";
import type { LearnerState } from "../state/types.js";
import { BLOCK_SHARES } from "./budget.js";
import {
  APPLY_NEW_EAR_PHRASES_PER_SESSION,
  APPLY_NEW_PHRASES_PER_SESSION,
  composePieceRun,
  composeSession,
} from "./compose.js";
import { NOW } from "./fixtures/learners.js";
import {
  ALPHA,
  BETA,
  FIXTURE_PIECES,
  GAMMA,
  PIECES_GRAPH,
  piecesGenerators,
  piecesGraph,
} from "./fixtures/pieces.js";
import { LANDMARKS, STEPS, readLearner } from "./fixtures/read.js";
import type { PlannedItem, SessionPlan } from "./types.js";

const generators = piecesGenerators();
const base = {
  graph: PIECES_GRAPH,
  now: NOW,
  tzOffsetMin: 0,
  seed: 7,
  generators,
  pieces: FIXTURE_PIECES,
};

const phraseId = (piece: string, phrase: number) => itemId(PIECES_NODE_ID, { piece, phrase });

function learner(
  nodes: Record<string, NodeState>,
  o: {
    cards?: [string, number, number][];
    earCards?: [string, number, number][];
    completed?: string[];
    newToday?: number;
  } = {},
): LearnerState {
  const state = readLearner({
    graph: PIECES_GRAPH,
    nodes,
    cards: [
      ...(o.cards ?? []).map(([piece, phrase, dueInDays]) => ({
        nodeId: PIECES_NODE_ID,
        params: { piece, phrase },
        dueInDays,
      })),
      ...(o.earCards ?? []).map(([piece, phrase, dueInDays]) => ({
        nodeId: PIECE_EAR_NODE_ID,
        params: { piece, phrase },
        dueInDays,
      })),
    ],
    ...(o.newToday === undefined ? {} : { newToday: o.newToday }),
  });
  for (const id of o.completed ?? []) {
    state.pieces[id] = { phrases: {}, runs: 1, lastRunAt: NOW, completedAt: NOW };
  }
  return state;
}

const compose = (
  state: LearnerState,
  o: {
    mode?: "instrument" | "away";
    budgetSec?: number;
    practice?: boolean;
    pieces?: boolean;
  } = {},
): SessionPlan => {
  const { pieces, ...rest } = base;
  return composeSession({
    ...(o.pieces === false ? rest : { ...rest, pieces }),
    state,
    mode: o.mode ?? "instrument",
    ...(o.budgetSec ? { budgetSec: o.budgetSec } : {}),
    ...(o.practice ? { practice: true } : {}),
  });
};

const lines = (items: PlannedItem[] | null) =>
  (items ?? []).map(
    (i) =>
      `${i.isNew ? "NEW" : "due"} ${i.itemId.replace(`${PIECES_NODE_ID}|`, "")} ${String(i.estimatedSec)}s`,
  );

const FLUENT_LANDMARKS = { [LANDMARKS]: "fluent" as const };
const FLUENT_ALL = { [LANDMARKS]: "fluent" as const, [STEPS]: "fluent" as const };

describe("Apply block: piece phrases (MP)", () => {
  it("is null without a piece library", () => {
    expect(compose(learner(FLUENT_ALL), { pieces: false }).blocks.apply).toBeNull();
  });

  it("shares the daily new-item cap: other blocks keep their due items, new items stay within the cap", () => {
    const state = learner(FLUENT_ALL, {
      cards: [[ALPHA, 1, -1]],
    });
    const without = compose(state, { pieces: false });
    const withPieces = compose(state);
    const due = (p: SessionPlan) =>
      [...p.blocks.ear, ...p.blocks.read].filter((i) => !i.isNew).map((i) => i.itemId);
    expect(due(withPieces)).toEqual(due(without));
    const fresh = (p: SessionPlan) =>
      [...p.blocks.ear, ...p.blocks.read, ...(p.blocks.apply ?? [])].filter((i) => i.isNew).length;
    expect(fresh(withPieces)).toBeLessThanOrEqual(withPieces.diagnostics.newAllowance);
    expect(fresh(without)).toBeLessThanOrEqual(without.diagnostics.newAllowance);
    // Pieces take a share rather than none, so reading gets no more new items than before.
    const newRead = (p: SessionPlan) => p.blocks.read.filter((i) => i.isNew).length;
    expect(newRead(withPieces)).toBeLessThanOrEqual(newRead(without));
    expect((withPieces.blocks.apply ?? []).some((i) => i.isNew)).toBe(true);
  });

  it("is null when the generator is not implemented in the graph or not in the registry", () => {
    const state = learner(FLUENT_ALL);
    expect(compose(state, { pieces: true }).blocks.apply).not.toBeNull();
    const off = composeSession({ ...base, graph: piecesGraph(false), state, mode: "instrument" });
    expect(off.blocks.apply).toBeNull();
    const rest = { ...generators };
    delete rest.pieceLine;
    const missing = composeSession({ ...base, generators: rest, state, mode: "instrument" });
    expect(missing.blocks.apply).toBeNull();
  });

  it("golden: a learner whose first reading nodes are fluent is offered the first piece", () => {
    const plan = compose(learner(FLUENT_LANDMARKS));
    expect(lines(plan.blocks.apply)).toEqual([
      "NEW phrase=1|piece=piece.alpha 25s",
      "NEW phrase=2|piece=piece.alpha 25s",
    ]);
    expect(plan.blocks.apply?.map((i) => i.nodeId)).toEqual([PIECES_NODE_ID, PIECES_NODE_ID]);
    expect(plan.blocks.apply?.every((i) => i.generator === "pieceLine")).toBe(true);
    expect(plan.blocks.apply?.[0]?.params).toEqual({ piece: ALPHA, phrase: 1 });
    expect(plan.diagnostics.notes).not.toContain("apply has no content");
  });

  it("unlock rule: nothing while a required node is only learning", () => {
    const plan = compose(learner({ [LANDMARKS]: "learning" }));
    expect(plan.blocks.apply).toBeNull();
    expect(plan.diagnostics.notes).toContain("apply has no content");
  });

  it("unlock rule: the next piece needs its own nodes, so the second waits for steps", () => {
    const plan = compose(learner(FLUENT_LANDMARKS, { completed: [ALPHA] }));
    expect(plan.blocks.apply).toBeNull();
    const plan2 = compose(learner(FLUENT_ALL, { completed: [ALPHA] }));
    expect(lines(plan2.blocks.apply)).toEqual([
      "NEW phrase=1|piece=piece.beta 25s",
      "NEW phrase=2|piece=piece.beta 25s",
    ]);
  });

  it(`offers at most ${String(APPLY_NEW_PHRASES_PER_SESSION)} new phrases a session, in order`, () => {
    const plan = compose(learner(FLUENT_ALL, { completed: [ALPHA] }));
    expect(plan.blocks.apply).toHaveLength(APPLY_NEW_PHRASES_PER_SESSION);
    const next = compose(
      learner(FLUENT_ALL, {
        completed: [ALPHA],
        cards: [
          [BETA, 1, 5],
          [BETA, 2, 5],
        ],
      }),
    );
    expect(lines(next.blocks.apply)).toEqual(["NEW phrase=3|piece=piece.beta 25s"]);
  });

  it("due phrases come first, most overdue first, then new ones", () => {
    const plan = compose(
      learner(FLUENT_LANDMARKS, {
        cards: [
          [ALPHA, 1, -1],
          [GAMMA, 1, -9],
        ],
      }),
    );
    expect(lines(plan.blocks.apply)).toEqual([
      "due phrase=1|piece=piece.gamma 25s",
      "due phrase=1|piece=piece.alpha 25s",
      "NEW phrase=2|piece=piece.alpha 25s",
    ]);
  });

  it("a phrase that is not due yet is left out; a completed piece offers nothing new", () => {
    const plan = compose(
      learner(FLUENT_LANDMARKS, {
        completed: [ALPHA],
        cards: [
          [ALPHA, 1, 4],
          [ALPHA, 2, 4],
        ],
      }),
    );
    expect(plan.blocks.apply).toBeNull();
  });

  it("when every phrase has a card but the piece is not played through, there is nothing new", () => {
    const plan = compose(
      learner(FLUENT_LANDMARKS, {
        cards: [
          [ALPHA, 1, 3],
          [ALPHA, 2, 3],
        ],
      }),
    );
    expect(plan.blocks.apply).toBeNull();
  });

  it("is never offered in Away mode or in practice", () => {
    const state = learner(FLUENT_ALL, { cards: [[ALPHA, 1, -2]] });
    expect(compose(state, { mode: "away" }).blocks.apply).toBeNull();
    expect(compose(state, { practice: true }).blocks.apply).toBeNull();
  });

  it("is dropped under time pressure (300 s or less), as the budget says", () => {
    const plan = compose(learner(FLUENT_ALL), { budgetSec: 300 });
    expect(plan.blocks.apply).toBeNull();
    expect(plan.diagnostics.notes).toContain("time pressure: apply dropped");
  });

  it("takes about a third of the budget and counts toward the session estimate", () => {
    const plan = compose(learner(FLUENT_LANDMARKS), { budgetSec: 720 });
    const applySec = (plan.blocks.apply ?? []).reduce((s, i) => s + i.estimatedSec, 0);
    expect(applySec).toBeGreaterThan(0);
    expect(applySec).toBeLessThanOrEqual(Math.round(BLOCK_SHARES.apply * 720));
    const others = [...plan.blocks.ear, ...plan.blocks.read].reduce(
      (s, i) => s + i.estimatedSec,
      0,
    );
    expect(plan.estimatedSec).toBe((plan.orient?.estimatedSec ?? 0) + others + applySec);
  });

  it("new phrases respect the daily new-item cap; due phrases still come", () => {
    const state = learner(FLUENT_LANDMARKS, { cards: [[ALPHA, 1, -1]], newToday: 999 });
    const plan = compose(state);
    expect(lines(plan.blocks.apply)).toEqual(["due phrase=1|piece=piece.alpha 25s"]);
  });

  it("counts due phrases in the diagnostics", () => {
    const plan = compose(learner(FLUENT_LANDMARKS, { cards: [[ALPHA, 1, -1]] }));
    expect(plan.diagnostics.dueCount).toBeGreaterThanOrEqual(1);
  });

  it("is deterministic", () => {
    const state = learner(FLUENT_ALL, { cards: [[ALPHA, 1, -1]] });
    expect(compose(state)).toEqual(compose(state));
  });
});

describe("Apply block properties", () => {
  const STATES: NodeState[] = ["locked", "available", "learning", "fluent", "mastered"];
  const scenario = fc.record({
    landmarks: fc.constantFrom(...STATES),
    steps: fc.constantFrom(...STATES),
    cards: fc.array(
      fc.tuple(
        fc.constantFrom(ALPHA, BETA, GAMMA),
        fc.integer({ min: 1, max: 3 }),
        fc.integer({ min: -10, max: 10 }),
      ),
      { maxLength: 6 },
    ),
    completed: fc.subarray([ALPHA, BETA, GAMMA]),
    newToday: fc.integer({ min: 0, max: 9 }),
    mode: fc.constantFrom<"instrument" | "away">("instrument", "away"),
    budgetSec: fc.integer({ min: 60, max: 1500 }),
    seed: fc.integer({ min: 0, max: 0x7fffffff }),
  });

  const build = (r: {
    landmarks: NodeState;
    steps: NodeState;
    cards: [string, number, number][];
    completed: string[];
    newToday: number;
  }) => {
    // Cards only for phrases that exist: beta has 3, alpha 2, gamma 1.
    const limit: Record<string, number> = { [ALPHA]: 2, [BETA]: 3, [GAMMA]: 1 };
    const cards = r.cards.filter(([p, n]) => n <= (limit[p] ?? 0));
    const unique = [...new Map(cards.map((c) => [`${c[0]}${String(c[1])}`, c])).values()];
    return learner(
      { [LANDMARKS]: r.landmarks, [STEPS]: r.steps },
      { cards: unique, completed: r.completed, newToday: r.newToday },
    );
  };

  it("never offers a new phrase of a locked or finished piece, and at most one piece's new phrases", () => {
    fc.assert(
      fc.property(scenario, (r) => {
        const state = build(r);
        const plan = composeSession({
          ...base,
          state,
          mode: r.mode,
          budgetSec: r.budgetSec,
          seed: r.seed,
        });
        const fresh = (plan.blocks.apply ?? []).filter((i) => i.isNew);
        expect(fresh.length).toBeLessThanOrEqual(APPLY_NEW_PHRASES_PER_SESSION);
        const pieceIds = new Set(
          fresh.flatMap((i) => (typeof i.params.piece === "string" ? [i.params.piece] : [])),
        );
        expect(pieceIds.size).toBeLessThanOrEqual(1);
        for (const id of pieceIds) {
          const piece = FIXTURE_PIECES.find((p) => p.id === id);
          for (const node of piece?.requiredNodeIds ?? []) {
            expect(["fluent", "mastered"]).toContain(state.nodes[node]?.state);
          }
          expect(state.pieces[id]?.completedAt).toBeUndefined();
        }
        for (const i of fresh) expect(state.cards[i.itemId]).toBeUndefined();
      }),
      { numRuns: 200 },
    );
  });

  it("keeps the budget, puts due before new, has no repeats, and leaves the other blocks alone", () => {
    fc.assert(
      fc.property(scenario, (r) => {
        const state = build(r);
        const plan = composeSession({
          ...base,
          state,
          mode: r.mode,
          budgetSec: r.budgetSec,
          seed: r.seed,
        });
        const apply = plan.blocks.apply ?? [];
        if (r.mode === "away" || r.budgetSec <= 300) expect(plan.blocks.apply).toBeNull();
        const sec = apply.reduce((s, i) => s + i.estimatedSec, 0);
        expect(sec).toBeLessThanOrEqual(Math.round(BLOCK_SHARES.apply * r.budgetSec));
        const firstNew = apply.findIndex((i) => i.isNew);
        if (firstNew >= 0) expect(apply.slice(firstNew).every((i) => i.isNew)).toBe(true);
        expect(new Set(apply.map((i) => i.itemId)).size).toBe(apply.length);
        const others = new Set([...plan.blocks.ear, ...plan.blocks.read].map((i) => i.itemId));
        for (const i of apply) expect(others.has(i.itemId)).toBe(false);
        for (const block of [plan.blocks.ear, plan.blocks.read]) {
          for (let k = 1; k < block.length; k++) {
            const a = block[k - 1];
            const b = block[k];
            if (a && b && block.length > 2) expect(a.itemId).not.toBe(b.itemId);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe("composePieceRun", () => {
  const input = (state: LearnerState, pieceId: string) => ({
    state,
    graph: PIECES_GRAPH,
    pieces: FIXTURE_PIECES,
    pieceId,
    now: NOW,
    tzOffsetMin: 0,
    generators,
  });

  it("plans every phrase of the piece in order, as the Apply block of a session of its own", () => {
    const plan = composePieceRun(input(learner(FLUENT_ALL), BETA));
    expect(plan.run).toEqual({ pieceId: BETA });
    expect(plan.mode).toBe("instrument");
    expect(plan.orient).toBeNull();
    expect(plan.blocks.ear).toEqual([]);
    expect(plan.blocks.read).toEqual([]);
    expect(plan.introductions).toEqual([]);
    expect(lines(plan.blocks.apply)).toEqual([
      "NEW phrase=1|piece=piece.beta 25s",
      "NEW phrase=2|piece=piece.beta 25s",
      "NEW phrase=3|piece=piece.beta 25s",
    ]);
    expect(plan.estimatedSec).toBe(75);
    expect(plan.budgetSec).toBeGreaterThanOrEqual(plan.estimatedSec);
  });

  it("marks phrases that already have a card as not new", () => {
    const plan = composePieceRun(input(learner(FLUENT_ALL, { cards: [[ALPHA, 1, 3]] }), ALPHA));
    expect(plan.blocks.apply?.map((i) => i.isNew)).toEqual([false, true]);
    expect(plan.blocks.apply?.[0]?.itemId).toBe(phraseId(ALPHA, 1));
  });

  it("throws for an unknown piece, a locked piece and a graph without pieces", () => {
    expect(() => composePieceRun(input(learner(FLUENT_ALL), "piece.nope"))).toThrow(
      "unknown piece",
    );
    expect(() => composePieceRun(input(learner({ [LANDMARKS]: "learning" }), ALPHA))).toThrow(
      "locked",
    );
    expect(() =>
      composePieceRun({ ...input(learner(FLUENT_ALL), ALPHA), graph: piecesGraph(false) }),
    ).toThrow("not enabled");
  });
});

describe("Apply block: play it by ear (TP.6)", () => {
  const earId = (piece: string, phrase: number) => itemId(PIECE_EAR_NODE_ID, { piece, phrase });

  /** Mark phrases 1..n of a piece as read correctly. */
  function read(state: LearnerState, piece: string, n: number): LearnerState {
    const phrases: Record<
      string,
      { attempts: number; correct: number; lastAt: number; lastCorrect: boolean }
    > = {};
    for (let i = 1; i <= n; i++) {
      phrases[String(i)] = { attempts: 1, correct: 1, lastAt: NOW, lastCorrect: true };
    }
    state.pieces[piece] = { phrases, runs: 0 };
    return state;
  }
  const earItems = (plan: SessionPlan) =>
    (plan.blocks.apply ?? []).filter((i) => i.generator === "pieceEar");

  /** ALPHA's two phrases, read and scheduled for later, as they are once a learner has read them. */
  const READ_ALPHA: [string, number, number][] = [
    [ALPHA, 1, 3],
    [ALPHA, 2, 3],
  ];

  it("offers nothing by ear until every phrase of a piece has been read", () => {
    const partly = read(learner(FLUENT_LANDMARKS, { cards: [[ALPHA, 1, 3]] }), ALPHA, 1);
    expect(earItems(compose(partly))).toEqual([]);
    expect(earItems(compose(learner(FLUENT_LANDMARKS)))).toEqual([]);
  });

  it("offers the first phrase of a fully read piece, new, and no more than the per-session limit", () => {
    const state = read(learner(FLUENT_LANDMARKS, { cards: READ_ALPHA }), ALPHA, 2);
    const ear = earItems(compose(state));
    expect(ear).toHaveLength(APPLY_NEW_EAR_PHRASES_PER_SESSION);
    expect(ear[0]).toMatchObject({
      itemId: earId(ALPHA, 1),
      nodeId: PIECE_EAR_NODE_ID,
      isNew: true,
      params: { piece: ALPHA, phrase: 1 },
    });
  });

  it("brings back a heard phrase when it is due, and moves on to the next phrase", () => {
    const state = read(
      learner(FLUENT_LANDMARKS, { cards: READ_ALPHA, earCards: [[ALPHA, 1, -1]] }),
      ALPHA,
      2,
    );
    const ear = earItems(compose(state));
    expect(ear.map((i) => `${i.isNew ? "NEW" : "due"} ${JSON.stringify(i.params.phrase)}`)).toEqual(
      ["due 1", "NEW 2"],
    );
  });

  it("is not offered in Away mode, in practice, or without a library", () => {
    const state = read(learner(FLUENT_LANDMARKS, { cards: READ_ALPHA }), ALPHA, 2);
    expect(earItems(compose(state, { mode: "away" }))).toEqual([]);
    expect(earItems(compose(state, { practice: true }))).toEqual([]);
    expect(earItems(compose(state, { pieces: false }))).toEqual([]);
  });

  it("is not offered when the by-ear generator is off in the graph or missing from the registry", () => {
    const state = read(learner(FLUENT_LANDMARKS, { cards: READ_ALPHA }), ALPHA, 2);
    const off = composeSession({ ...base, graph: piecesGraph(false), state, mode: "instrument" });
    expect(off.blocks.apply).toBeNull();
    const rest = { ...generators };
    delete rest.pieceEar;
    const missing = composeSession({ ...base, generators: rest, state, mode: "instrument" });
    expect(earItems(missing)).toEqual([]);
  });

  it("offers only reading phrases to a learner who has read nothing", () => {
    const state = learner(FLUENT_LANDMARKS);
    // Hearing a phrase never records a piece phrase, so the piece is still the current one to read.
    const plan = compose(state);
    expect((plan.blocks.apply ?? []).every((i) => i.generator === "pieceLine")).toBe(true);
  });
});
