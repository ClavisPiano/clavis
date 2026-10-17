import { describe, expect, it } from "vitest";
import { eventFixtures } from "../events/fixtures/index.js";
import type { ContentImported } from "../events/learning.js";
import { itemId } from "../items/ids.js";
import { PIECES_NODE_ID } from "../items/piece-line.js";
import { allPieces } from "../pieces/list.js";
import { UserPieceSchema } from "../pieces/schema.js";
import { composePieceRun, composeSession } from "./compose.js";
import { NOW } from "./fixtures/learners.js";
import { FIXTURE_PIECES, PIECES_GRAPH, piecesGenerators } from "./fixtures/pieces.js";
import { readLearner } from "./fixtures/read.js";

/*
 * T7.4: an imported piece goes through the same generator and composer path as a library piece. The
 * learner has no skills at all, so every library piece is locked and only the import is offered.
 */

const event = eventFixtures["content.imported"] as ContentImported;
const piece = UserPieceSchema.parse({
  id: event.pieceId,
  title: event.title,
  source: "Imported",
  score: event.score,
  phrases: event.phrases,
  requiredNodeIds: [],
  difficulty: event.difficulty,
});

function learner() {
  const state = readLearner({ graph: PIECES_GRAPH, nodes: {} });
  state.imported[piece.id] = {
    piece,
    source: "musicxml",
    partIndex: 0,
    staff: 1,
    at: event.at,
    eventId: event.id,
  };
  return state;
}

const input = () => {
  const state = learner();
  const pieces = allPieces(FIXTURE_PIECES, state);
  return {
    graph: PIECES_GRAPH,
    now: NOW,
    tzOffsetMin: 0,
    seed: 3,
    state,
    pieces,
    generators: piecesGenerators(pieces),
  };
};

describe("imported pieces in the composer", () => {
  it("offers the phrases of an imported piece like a library piece's", () => {
    const plan = composeSession({ ...input(), mode: "instrument" });
    expect(plan.blocks.apply?.map((i) => i.params)).toEqual([{ piece: piece.id, phrase: 1 }]);
    const item = plan.blocks.apply?.[0];
    expect(item?.nodeId).toBe(PIECES_NODE_ID);
    expect(item?.generator).toBe("pieceLine");
    expect(item?.isNew).toBe(true);
    // The item id is stable (R1): the node, the phrase and the user piece id, nothing random.
    expect(item?.itemId).toBe(itemId(PIECES_NODE_ID, { piece: piece.id, phrase: 1 }));
    expect(item?.itemId).toContain("piece=piece.user-");
  });

  it("generates a self-contained item (R2) with the same shape as a library phrase", () => {
    const i = input();
    const gen = i.generators.pieceLine;
    const node = PIECES_GRAPH.nodes.find((n) => n.id === PIECES_NODE_ID);
    if (gen === undefined || node === undefined) throw new Error("pieces are not set up");
    const params = { piece: piece.id, phrase: 1 };
    const a = gen.generate(node, params, { rng: () => 0.5 } as never);
    const b = gen.generate(node, params, { rng: () => 0.1 } as never);
    expect(a).toEqual(b);
    expect(a.presentation).toEqual({ piece: piece.id, phrase: 1, tempoBpm: 60 });
    expect(a.display?.staves[0]?.measures).toHaveLength(2);
    expect(a.expected.play?.kind).toBe("line");
    expect(gen.listItems(node).map((p) => p.piece)).toContain(piece.id);
  });

  it("a whole-piece run plans every phrase of an imported piece", () => {
    const i = input();
    const plan = composePieceRun({
      state: i.state,
      graph: i.graph,
      pieces: i.pieces,
      pieceId: piece.id,
      now: NOW,
      tzOffsetMin: 0,
      generators: i.generators,
    });
    expect(plan.run).toEqual({ pieceId: piece.id });
    expect(plan.blocks.apply?.map((x) => x.params)).toEqual([{ piece: piece.id, phrase: 1 }]);
  });

  it("offers nothing from an import that is absent from the pieces input", () => {
    const i = input();
    const plan = composeSession({
      ...i,
      pieces: FIXTURE_PIECES,
      generators: piecesGenerators(FIXTURE_PIECES),
      mode: "instrument",
    });
    expect(plan.blocks.apply).toBeNull();
  });
});
