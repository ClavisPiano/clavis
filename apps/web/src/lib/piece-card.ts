import {
  isHandsPiece,
  listPieces,
  pieceHand,
  type LearnerState,
  type Piece,
  type SkillGraph,
} from "@clavis/core";

/*
 * What Home shows about pieces (MP, TP.5). Pure, from the learner state and the library, so the
 * card, the session summary and the tests agree. One one-hand piece is current at a time: the first
 * unlocked one that has not been played through (the composer teaches the same one). Hands-together
 * pieces (T5.6) have a current piece of their own, chosen the same way, which the composer teaches
 * alongside.
 */

export type PieceStatus =
  /** Current: phrases are still being learned. */
  | "playing"
  /** Current: every phrase has been played right at least once, so it can be played through. */
  | "ready"
  | "completed"
  /** Unlocked, waiting behind the current piece. */
  | "next"
  | "locked";

export interface PieceRow {
  id: string;
  title: string;
  source: string;
  hand: "right" | "left" | "both";
  phraseCount: number;
  /** Phrases played right at least once. */
  learned: number;
  status: PieceStatus;
  /** Titles of the skills still to reach `fluent`, for a locked piece. */
  missing: string[];
  /** A locked hands-together piece (T5.6): the title of the tune to play through first. */
  after?: string;
  /** Whole-piece runs finished, whatever their result. */
  runs: number;
}

export interface PieceCardData {
  rows: PieceRow[];
  /** The current one-hand piece, or the current hands-together one when no one-hand piece is. */
  current: PieceRow | undefined;
  /** The current hands-together piece (T5.6) when it is learned alongside `current`. */
  handsCurrent: PieceRow | undefined;
  completed: PieceRow[];
}

/** True when the graph offers pieces at all (the pieces node and `pieceLine` are enabled). */
export function piecesEnabled(graph: SkillGraph): boolean {
  const info = graph.generators.find((g) => g.id === "pieceLine");
  return info?.implemented === true && graph.nodes.some((n) => n.strand === "APPLY");
}

export function pieceCard(
  pieces: readonly Piece[],
  state: LearnerState,
  graph: SkillGraph,
): PieceCardData | undefined {
  if (!piecesEnabled(graph) || pieces.length === 0) return undefined;
  const title = (id: string): string => graph.nodes.find((n) => n.id === id)?.title ?? id;
  const statuses = listPieces(pieces, state);
  const currentOf = (hands: boolean): string | undefined =>
    statuses.find(
      (s) =>
        s.unlocked &&
        isHandsPiece(s.piece) === hands &&
        state.pieces[s.piece.id]?.completedAt === undefined,
    )?.piece.id;
  const oneHandId = currentOf(false);
  const handsId = currentOf(true);
  const pieceTitle = (id: string): string => pieces.find((p) => p.id === id)?.title ?? id;

  const rows = statuses.map((s): PieceRow => {
    const record = state.pieces[s.piece.id];
    const phraseCount = s.piece.phrases.length;
    let learned = 0;
    for (let n = 1; n <= phraseCount; n++) {
      if ((record?.phrases[String(n)]?.correct ?? 0) > 0) learned++;
    }
    let status: PieceStatus;
    if (!s.unlocked) status = "locked";
    else if (record?.completedAt !== undefined) status = "completed";
    else if (s.piece.id === oneHandId || s.piece.id === handsId) {
      status = learned === phraseCount ? "ready" : "playing";
    } else status = "next";
    return {
      id: s.piece.id,
      title: s.piece.title,
      source: s.piece.source,
      hand: pieceHand(s.piece),
      phraseCount,
      learned,
      status,
      missing: s.missingNodeIds.map(title),
      ...(s.missingPieceIds[0] === undefined ? {} : { after: pieceTitle(s.missingPieceIds[0]) }),
      runs: record?.runs ?? 0,
    };
  });
  const handsRow = rows.find((r) => r.id === handsId);
  return {
    rows,
    current: rows.find((r) => r.id === oneHandId) ?? handsRow,
    handsCurrent: oneHandId === undefined ? undefined : handsRow,
    completed: rows.filter((r) => r.status === "completed"),
  };
}
