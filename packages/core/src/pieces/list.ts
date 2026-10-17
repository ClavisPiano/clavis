import type { NodeState, SkillGraph } from "../graph/schema.js";
import { isNodeEnabled } from "../graph/validate.js";
import type { LearnerState } from "../state/types.js";
import type { Piece } from "./schema.js";

/**
 * The state every required node must have reached before a piece is offered: "past learning", as the
 * MP exit criterion says. Reading a phrase needs the notes to be quick to find, not just introduced.
 */
export const PIECE_UNLOCK_STATE: NodeState = "fluent";

const STATE_RANK: Record<NodeState, number> = {
  locked: 0,
  available: 1,
  learning: 2,
  fluent: 3,
  mastered: 4,
};

export interface PieceStatus {
  piece: Piece;
  unlocked: boolean;
  /** Required nodes still below `PIECE_UNLOCK_STATE`, in the piece's order. What unlocks the piece. */
  missingNodeIds: string[];
}

/**
 * Every piece with whether the learner can play it yet. Pure: keeps the library's order (easiest
 * first) and reads only node states, so a refolded learner state gives the same list.
 */
export function listPieces(
  pieces: readonly Piece[],
  learner: Pick<LearnerState, "nodes">,
): PieceStatus[] {
  const need = STATE_RANK[PIECE_UNLOCK_STATE];
  return pieces.map((piece) => {
    const missingNodeIds = piece.requiredNodeIds.filter(
      (id) => STATE_RANK[learner.nodes[id]?.state ?? "locked"] < need,
    );
    return { piece, unlocked: missingNodeIds.length === 0, missingNodeIds };
  });
}

/**
 * The pieces the app offers: the learner's imports first (oldest first), then the library. An
 * imported piece has no required nodes, so it is unlocked at once and becomes the current piece
 * until it is played through. Pure, from the state's imported records.
 */
export function allPieces(
  library: readonly Piece[],
  learner: Pick<LearnerState, "imported">,
): Piece[] {
  const own = Object.values(learner.imported)
    .sort((a, b) => a.at - b.at || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0))
    .map((r) => r.piece);
  return [...own, ...library];
}

/** Problems that need the skill graph to find. Empty when the library is consistent with it. */
export function validatePieces(
  pieces: readonly Piece[],
  graph: Pick<SkillGraph, "nodes" | "generators">,
): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const piece of pieces) {
    if (ids.has(piece.id)) errors.push(`${piece.id}: duplicate piece id`);
    ids.add(piece.id);
    for (const nodeId of piece.requiredNodeIds) {
      const node = graph.nodes.find((n) => n.id === nodeId);
      if (node === undefined) {
        errors.push(`${piece.id}: required node ${nodeId} is not in the graph`);
      } else if (!isNodeEnabled(node, graph.generators)) {
        errors.push(`${piece.id}: required node ${nodeId} has no implemented generator`);
      }
    }
  }
  for (let i = 1; i < pieces.length; i++) {
    const prev = pieces[i - 1];
    const cur = pieces[i];
    if (prev !== undefined && cur !== undefined && cur.difficulty < prev.difficulty) {
      errors.push(
        `${cur.id}: difficulty ${String(cur.difficulty)} is below ${prev.id} (${String(prev.difficulty)})`,
      );
    }
  }
  return errors;
}
