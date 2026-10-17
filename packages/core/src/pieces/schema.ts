import { z } from "zod";
import { ScoreSpecSchema, type ScoreSpec } from "../score/schema.js";

/*
 * A piece is a short public-domain melody for one hand, split into phrases (MP, TP.3). The score
 * is the same notation-free `ScoreSpec` that READ items carry, so the notation runtime draws it
 * and the grading expectations (`sequence`, `rhythm`) are derived from it in TP.4.
 *
 * v1 pieces are a single line: one staff, one pitch per note, full measures only (no pickup bar).
 * Hands together waits for M5.
 */

/** Length of a whole note in the unit used to total a measure (64ths, so a dotted 16th is whole). */
const WHOLE = 64;

function durationUnits(d: { value: number; dots: number }): number {
  const base = WHOLE / d.value;
  return d.dots === 1 ? base * 1.5 : base;
}

/** The length of every measure of `score`, in 64ths. Null when the score has no meter. */
export function measureUnits(score: ScoreSpec): number | null {
  if (score.meter === null) return null;
  return (score.meter.beats * WHOLE) / score.meter.beatValue;
}

/** A run of whole measures, counted from 1 and inclusive at both ends. */
export const PhraseSchema = z
  .strictObject({
    firstMeasure: z.int().min(1),
    lastMeasure: z.int().min(1),
  })
  .refine((p) => p.firstMeasure <= p.lastMeasure, {
    message: "a phrase must not end before it starts",
    path: ["lastMeasure"],
  });
export type Phrase = z.infer<typeof PhraseSchema>;

const pieceShape = {
  title: z.string().min(1),
  /** Composer, or "Traditional". The full provenance is in `docs/licences.md`. */
  source: z.string().min(1),
  score: ScoreSpecSchema,
  /** Tile the measures exactly: the first starts at 1, each starts after the last, the last ends the score. */
  phrases: z.array(PhraseSchema).min(1),
  /** 1 (easiest) to 10. The library is ordered by it. */
  difficulty: z.int().min(1).max(10),
};

/** What `refinePiece` reads, so the library and user schemas share it. */
interface Refinable {
  score: ScoreSpec;
  phrases: Phrase[];
  requiredNodeIds: string[];
}

function refinePiece(piece: Refinable, ctx: z.RefinementCtx): void {
  const staff = piece.score.staves[0];
  if (staff === undefined) return;
  // Phrases, hands and line notes read the first staff only; grand-staff pieces are T5.6. This
  // also keeps `content.imported` v1, which validates its payload as a user piece, as it shipped.
  if (piece.score.staves.length > 1) {
    ctx.addIssue({
      code: "custom",
      message: "a piece has a single staff",
      path: ["score", "staves"],
    });
  }
  if (staff.clef === "percussion") {
    ctx.addIssue({
      code: "custom",
      message: "a piece is pitched, not percussion",
      path: ["score", "staves", 0, "clef"],
    });
  }
  if (piece.score.key === null) {
    ctx.addIssue({ code: "custom", message: "a piece needs a key", path: ["score", "key"] });
  }
  const units = measureUnits(piece.score);
  if (units === null) {
    ctx.addIssue({ code: "custom", message: "a piece needs a meter", path: ["score", "meter"] });
  }
  staff.measures.forEach((measure, m) => {
    if (measure.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: `measure ${String(m + 1)} is empty`,
        path: ["score", "staves", 0, "measures", m],
      });
      return;
    }
    if (units !== null) {
      const total = measure.reduce((sum, el) => sum + durationUnits(el.duration), 0);
      if (total !== units) {
        ctx.addIssue({
          code: "custom",
          message: `measure ${String(m + 1)} does not fill the meter (${String(total)}/64 of ${String(units)}/64)`,
          path: ["score", "staves", 0, "measures", m],
        });
      }
    }
    measure.forEach((el, e) => {
      if (el.kind === "note" && el.pitches.length !== 1) {
        ctx.addIssue({
          code: "custom",
          message: "a piece is a single line: one pitch per note",
          path: ["score", "staves", 0, "measures", m, e, "pitches"],
        });
      }
    });
  });

  let next = 1;
  piece.phrases.forEach((p, i) => {
    if (p.firstMeasure !== next) {
      ctx.addIssue({
        code: "custom",
        message: `phrases must tile the measures: expected phrase ${String(i + 1)} to start at ${String(next)}`,
        path: ["phrases", i, "firstMeasure"],
      });
    }
    next = p.lastMeasure + 1;
  });
  if (next - 1 !== staff.measures.length) {
    ctx.addIssue({
      code: "custom",
      message: `phrases end at measure ${String(next - 1)} but the score has ${String(staff.measures.length)}`,
      path: ["phrases"],
    });
  }
  if (new Set(piece.requiredNodeIds).size !== piece.requiredNodeIds.length) {
    ctx.addIssue({
      code: "custom",
      message: "requiredNodeIds must be unique",
      path: ["requiredNodeIds"],
    });
  }
}

export const PieceSchema = z
  .strictObject({
    id: z.string().regex(/^piece\.[a-z0-9-]+$/),
    ...pieceShape,
    /** Skill nodes the learner needs before the piece is offered (see `listPieces`). */
    requiredNodeIds: z.array(z.string().min(1)).min(1),
  })
  .superRefine(refinePiece);

/** The `source` shown for every imported piece. */
export const IMPORTED_PIECE_SOURCE = "Imported";

/** Id of a piece the learner imported: `piece.user-` and a lowercase ULID. Fits the library pattern. */
export const USER_PIECE_ID_REGEX = /^piece\.user-[0-9a-z]{26}$/;

export function isUserPieceId(id: string): boolean {
  return USER_PIECE_ID_REGEX.test(id);
}

/** The piece id for an imported piece with ULID `ulid`. */
export function userPieceId(ulid: string): string {
  return `piece.user-${ulid.toLowerCase()}`;
}

/**
 * A piece the learner imported (T7.4). Same shape and score rules as a library piece, but it has no
 * required nodes, so it is unlocked from the start, and its id carries the `piece.user-` prefix.
 */
export const UserPieceSchema = z
  .strictObject({
    id: z.string().regex(USER_PIECE_ID_REGEX),
    ...pieceShape,
    requiredNodeIds: z.array(z.string().min(1)).max(0),
  })
  .superRefine(refinePiece);
export type Piece = z.infer<typeof PieceSchema>;

/** Right hand plays the treble staff, left hand the bass staff. */
export function pieceHand(piece: Pick<Piece, "score">): "right" | "left" {
  return piece.score.staves[0]?.clef === "bass" ? "left" : "right";
}

/** The measures of phrase `index` (0-based) as a score of their own, ids and key unchanged. */
export function phraseScore(piece: Piece, index: number): ScoreSpec {
  const phrase = piece.phrases[index];
  const staff = piece.score.staves[0];
  if (phrase === undefined || staff === undefined) {
    throw new RangeError(`piece ${piece.id} has no phrase ${String(index)}`);
  }
  return {
    ...piece.score,
    staves: [
      { ...staff, measures: staff.measures.slice(phrase.firstMeasure - 1, phrase.lastMeasure) },
    ],
  };
}
