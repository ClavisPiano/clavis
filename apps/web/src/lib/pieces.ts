import { loadPieces } from "@clavis/content";
import {
  GENERATORS,
  allPieces,
  createPieceEar,
  createPieceHands,
  createPieceLine,
  type Generator,
  type GeneratorId,
  type LearnerState,
  type Piece,
} from "@clavis/core";

/*
 * The pieces the app uses (MP, T7.4): the library plus the learner's imports. `pieceLine`,
 * `pieceEar` and `pieceHands` (T5.6) are built over those pieces, which live outside core, so they cannot be in the core
 * registry: the app builds them here and hands them, with the pieces, to the composer and the
 * session runtime. Imports change at runtime, so the set is derived from the learner state and
 * rebuilt whenever `state.imported` is a new object (every fold makes one).
 */

type Imported = Pick<LearnerState, "imported">;

interface Built {
  imported: LearnerState["imported"] | undefined;
  pieces: readonly Piece[];
  generators: Partial<Record<GeneratorId, Generator>>;
}

let library: readonly Piece[] | undefined;
let built: Built | undefined;

function libraryPieces(): readonly Piece[] {
  library ??= loadPieces();
  return library;
}

function build(state: Imported | undefined): Built {
  if (built !== undefined && built.imported === state?.imported) return built;
  const pieces = state === undefined ? libraryPieces() : allPieces(libraryPieces(), state);
  built = {
    imported: state?.imported,
    pieces,
    generators: {
      ...GENERATORS,
      pieceLine: createPieceLine(pieces),
      pieceEar: createPieceEar(pieces),
      pieceHands: createPieceHands(pieces),
    },
  };
  return built;
}

/** The learner's imported pieces first, then the library. Pass the state to include imports. */
export function appPieces(state?: Imported): readonly Piece[] {
  return build(state).pieces;
}

/** The core generators plus `pieceLine`, `pieceEar` and `pieceHands` over the app's pieces. */
export function appGenerators(state?: Imported): Partial<Record<GeneratorId, Generator>> {
  return build(state).generators;
}

/** What `composeSession` needs, beyond the learner and graph, to offer pieces. */
export function pieceInputs(state: Imported): {
  pieces: readonly Piece[];
  generators: Partial<Record<GeneratorId, Generator>>;
} {
  const b = build(state);
  return { pieces: b.pieces, generators: b.generators };
}

/** Generate an item with the app's generators (core ones and the piece ones). */
export function generatorFor(id: GeneratorId, state: Imported): Generator {
  const g = appGenerators(state)[id];
  if (g === undefined) throw new Error(`generator ${id} is not available`);
  return g;
}
