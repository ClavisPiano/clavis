import type { SkillGraph, SkillNode } from "../../graph/schema.js";
import { GENERATORS } from "../../items/registry.js";
import { PIECE_EAR_NODE_ID, createPieceEar } from "../../items/piece-ear.js";
import { PIECE_HANDS_NODE_ID, createPieceHands } from "../../items/piece-hands.js";
import { PIECES_NODE_ID, createPieceLine } from "../../items/piece-line.js";
import type { Generator } from "../../items/types.js";
import type { GeneratorId } from "../../graph/schema.js";
import { grandStaff, line } from "../../pieces/line.js";
import { PieceSchema, type Piece } from "../../pieces/schema.js";
import { LANDMARKS, READ_GRAPH, STEPS, STUB_READ_GENERATORS } from "./read.js";

/*
 * Test-only piece fixtures: three small pieces over the fixture READ nodes, a graph that adds the
 * pieces node and enables `pieceLine`, and a generator registry that injects the library.
 */

const KEY = { tonic: "C", mode: "major" } as const;
const METER = { beats: 4, beatValue: 4 } as const;
const bars = (...b: string[]) => b;

function piece(
  id: string,
  b: string[],
  phrases: [number, number][],
  requiredNodeIds: string[],
  difficulty: number,
): Piece {
  return PieceSchema.parse({
    id,
    title: id,
    source: "Traditional",
    score: line({ clef: "treble", key: KEY, meter: METER, bars: b }),
    phrases: phrases.map(([firstMeasure, lastMeasure]) => ({ firstMeasure, lastMeasure })),
    requiredNodeIds,
    difficulty,
  });
}

export const ALPHA = "piece.alpha";
export const BETA = "piece.beta";
export const GAMMA = "piece.gamma";

/** Alpha: 2 phrases, needs landmarks. Beta: 3 phrases, needs landmarks and steps. Gamma: 1 phrase, needs steps. */
export const FIXTURE_PIECES: readonly Piece[] = [
  piece(
    ALPHA,
    bars("C4q D4q E4h", "E4q D4q C4h", "C4q E4q G4h", "G4q E4q C4h"),
    [
      [1, 2],
      [3, 4],
    ],
    [LANDMARKS],
    1,
  ),
  piece(
    BETA,
    bars("E4q E4q F4q G4q", "G4q F4q E4q D4q", "C4q C4q D4q E4q", "E4q. D4e D4h", "C4w", "C4w"),
    [
      [1, 2],
      [3, 4],
      [5, 6],
    ],
    [LANDMARKS, STEPS],
    2,
  ),
  piece(GAMMA, bars("G4q A4q G4q F4q"), [[1, 1]], [STEPS], 3),
];

const piecesNode: SkillNode = {
  id: PIECES_NODE_ID,
  strand: "APPLY",
  title: "Pieces",
  prerequisites: [],
  itemGenerators: ["pieceLine"],
  params: {},
  mastery: { minAccuracy: 0.8, windowAttempts: 5, distinctSessions: 2 },
  keyDependent: false,
};

const earNode: SkillNode = {
  ...piecesNode,
  id: PIECE_EAR_NODE_ID,
  title: "Pieces by ear",
  itemGenerators: ["pieceEar"],
};

/** The READ fixture graph plus the pieces nodes, with `pieceLine` and `pieceEar` implemented. */
export function piecesGraph(implemented = true): SkillGraph {
  return {
    ...READ_GRAPH,
    generators: [
      ...READ_GRAPH.generators.filter((g) => g.id !== "pieceLine" && g.id !== "pieceEar"),
      {
        id: "pieceLine",
        implemented,
        seedDurationSec: 25,
        awayEligible: false,
        requires: ["keys", "notation"],
      },
      {
        id: "pieceEar",
        implemented,
        seedDurationSec: 60,
        awayEligible: false,
        requires: ["mic", "keys", "notation"],
      },
    ],
    nodes: [...READ_GRAPH.nodes, piecesNode, earNode],
  };
}

export const PIECES_GRAPH = piecesGraph();

export function piecesGenerators(
  pieces: readonly Piece[] = FIXTURE_PIECES,
): Partial<Record<GeneratorId, Generator>> {
  return {
    ...GENERATORS,
    ...STUB_READ_GENERATORS,
    pieceLine: createPieceLine(pieces),
    pieceEar: createPieceEar(pieces),
    pieceHands: createPieceHands(pieces),
  };
}

export const ALPHA_HANDS = "piece.alpha-hands";

/**
 * Alpha for both hands (T5.6): its melody over one chord per bar. Needs steps, and alpha played
 * through. The fixture nodes stand in for `hands.coord.basic`.
 */
export const ALPHA_HANDS_PIECE: Piece = PieceSchema.parse({
  id: ALPHA_HANDS,
  title: "alpha for both hands",
  source: "Traditional",
  score: grandStaff({
    key: KEY,
    meter: METER,
    treble: bars("C4q D4q E4h", "E4q D4q C4h", "C4q E4q G4h", "G4q E4q C4h"),
    bass: bars("C3+E3+G3w", "C3+E3+G3w", "C3+E3+G3w", "C3+E3+G3w"),
  }),
  phrases: [
    { firstMeasure: 1, lastMeasure: 2 },
    { firstMeasure: 3, lastMeasure: 4 },
  ],
  requiredNodeIds: [STEPS],
  handsOf: ALPHA,
  difficulty: 4,
});

/** The fixture pieces plus alpha for both hands. */
export const HANDS_FIXTURE_PIECES: readonly Piece[] = [...FIXTURE_PIECES, ALPHA_HANDS_PIECE];

const handsNode: SkillNode = {
  ...piecesNode,
  id: PIECE_HANDS_NODE_ID,
  title: "Pieces, hands together",
  itemGenerators: ["pieceHands"],
};

/** The pieces graph plus the hands-together node, with `pieceHands` needing polyphonic input. */
export function handsPiecesGraph(): SkillGraph {
  const g = piecesGraph();
  return {
    ...g,
    generators: [
      ...g.generators.filter((x) => x.id !== "pieceHands"),
      {
        id: "pieceHands",
        implemented: true,
        seedDurationSec: 40,
        awayEligible: false,
        requires: ["keys", "polyphonic", "notation"],
      },
    ],
    nodes: [...g.nodes, handsNode],
  };
}
