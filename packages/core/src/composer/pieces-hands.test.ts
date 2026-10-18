import { describe, expect, it } from "vitest";
import type { NodeState } from "../graph/schema.js";
import { itemId } from "../items/ids.js";
import { PIECE_HANDS_NODE_ID } from "../items/piece-hands.js";
import { PIECES_NODE_ID } from "../items/piece-line.js";
import type { LearnerState } from "../state/types.js";
import { APPLY_NEW_PHRASES_PER_SESSION, composePieceRun, composeSession } from "./compose.js";
import { NOW } from "./fixtures/learners.js";
import {
  ALPHA,
  ALPHA_HANDS,
  BETA,
  GAMMA,
  HANDS_FIXTURE_PIECES,
  handsPiecesGraph,
  piecesGenerators,
} from "./fixtures/pieces.js";
import { LANDMARKS, STEPS, readLearner } from "./fixtures/read.js";
import type { PlannedItem, SessionPlan } from "./types.js";

/*
 * Hands-together pieces (T5.6): `pieceHands` phrases of `apply.pieces-hands` join the Apply block
 * like reading phrases, from the current hands piece (unlocked once its one-hand piece is played
 * through), with MIDI input only.
 */

const GRAPH = handsPiecesGraph();
const generators = piecesGenerators(HANDS_FIXTURE_PIECES);
const FLUENT_ALL: Record<string, NodeState> = { [LANDMARKS]: "fluent", [STEPS]: "fluent" };
const handsId = (phrase: number) => itemId(PIECE_HANDS_NODE_ID, { piece: ALPHA_HANDS, phrase });

function learner(
  o: { completed?: string[]; handsCards?: [number, number][]; newToday?: number } = {},
): LearnerState {
  const state = readLearner({
    graph: GRAPH,
    nodes: FLUENT_ALL,
    cards: (o.handsCards ?? []).map(([phrase, dueInDays]) => ({
      nodeId: PIECE_HANDS_NODE_ID,
      params: { piece: ALPHA_HANDS, phrase },
      dueInDays,
    })),
    ...(o.newToday === undefined ? {} : { newToday: o.newToday }),
  });
  for (const id of o.completed ?? []) {
    state.pieces[id] = { phrases: {}, runs: 1, lastRunAt: NOW, completedAt: NOW };
  }
  return state;
}

const compose = (
  state: LearnerState,
  o: { polyphonic?: boolean; mode?: "instrument" | "away"; practice?: boolean } = {},
): SessionPlan =>
  composeSession({
    graph: GRAPH,
    now: NOW,
    tzOffsetMin: 0,
    seed: 7,
    generators,
    pieces: HANDS_FIXTURE_PIECES,
    state,
    mode: o.mode ?? "instrument",
    ...(o.polyphonic === undefined ? {} : { polyphonic: o.polyphonic }),
    ...(o.practice ? { practice: true } : {}),
  });

const handsItems = (p: SessionPlan): PlannedItem[] =>
  (p.blocks.apply ?? []).filter((i) => i.nodeId === PIECE_HANDS_NODE_ID);

describe("Apply block: hands-together phrases (T5.6)", () => {
  it("offers the first new phrases of the hands piece with MIDI once its tune is played through", () => {
    // Every one-hand piece is played through, so the new-phrase share is the hands piece's alone.
    const plan = compose(learner({ completed: [ALPHA, BETA, GAMMA] }), { polyphonic: true });
    const items = handsItems(plan);
    expect(items.map((i) => i.itemId)).toEqual([handsId(1), handsId(2)]);
    expect(items.length).toBeLessThanOrEqual(APPLY_NEW_PHRASES_PER_SESSION);
    expect(items.every((i) => i.generator === "pieceHands" && i.isNew)).toBe(true);
  });

  it("drops the hands piece without MIDI, new and due phrases alike", () => {
    const state = learner({ completed: [ALPHA], handsCards: [[1, -2]] });
    expect(handsItems(compose(state, { polyphonic: false }))).toEqual([]);
    expect(handsItems(compose(state))).toEqual([]);
    // With MIDI the due phrase comes first.
    const midi = handsItems(compose(state, { polyphonic: true }));
    expect(midi[0]).toMatchObject({ itemId: handsId(1), isNew: false });
  });

  it("offers nothing while the one-hand tune has not been played through", () => {
    expect(handsItems(compose(learner(), { polyphonic: true }))).toEqual([]);
  });

  it("is never planned in Away mode or practice", () => {
    const state = learner({ completed: [ALPHA], handsCards: [[1, -2]] });
    expect(handsItems(compose(state, { polyphonic: true, mode: "away" }))).toEqual([]);
    expect(handsItems(compose(state, { polyphonic: true, practice: true }))).toEqual([]);
  });

  it("takes turns with new phrases of the current one-hand piece", () => {
    // Alpha is played through, so beta is the current one-hand piece. The new-phrase share is two
    // here (a third of the allowance of five): one phrase of each.
    const plan = compose(learner({ completed: [ALPHA] }), { polyphonic: true });
    expect(plan.diagnostics.newAllowance).toBe(5);
    expect((plan.blocks.apply ?? []).map((i) => i.itemId)).toEqual([
      itemId(PIECES_NODE_ID, { piece: BETA, phrase: 1 }),
      handsId(1),
    ]);
  });

  it("stops offering new phrases once the hands piece is played through", () => {
    const state = learner({ completed: [ALPHA, ALPHA_HANDS] });
    expect(handsItems(compose(state, { polyphonic: true }))).toEqual([]);
  });
});

describe("composePieceRun: a hands-together piece", () => {
  const input = (state: LearnerState, polyphonic?: boolean) => ({
    state,
    graph: GRAPH,
    pieces: HANDS_FIXTURE_PIECES,
    pieceId: ALPHA_HANDS,
    now: NOW,
    tzOffsetMin: 0,
    generators,
    ...(polyphonic === undefined ? {} : { polyphonic }),
  });

  it("plans every phrase with pieceHands, with MIDI", () => {
    const plan = composePieceRun(input(learner({ completed: [ALPHA] }), true));
    expect(plan.run).toEqual({ pieceId: ALPHA_HANDS });
    expect(plan.blocks.apply?.map((i) => [i.itemId, i.generator, i.estimatedSec])).toEqual([
      [handsId(1), "pieceHands", 40],
      [handsId(2), "pieceHands", 40],
    ]);
  });

  it("throws without MIDI, and while the one-hand tune is not played through", () => {
    expect(() => composePieceRun(input(learner({ completed: [ALPHA] })))).toThrow("MIDI");
    expect(() => composePieceRun(input(learner(), true))).toThrow(`locked: ${ALPHA}`);
  });
});
