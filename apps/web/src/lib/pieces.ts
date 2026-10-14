import { loadPieces } from "@clavis/content";
import {
  GENERATORS,
  createPieceLine,
  type Generator,
  type GeneratorId,
  type Piece,
} from "@clavis/core";

/*
 * The piece library as the app uses it (MP). `pieceLine` is built over the library, which lives in
 * `content`, so it cannot be in the core registry: the app builds it once here and hands it, with
 * the pieces, to the composer and the session runtime.
 */

let pieces: readonly Piece[] | undefined;
let generators: Partial<Record<GeneratorId, Generator>> | undefined;

export function appPieces(): readonly Piece[] {
  pieces ??= loadPieces();
  return pieces;
}

/** The core generators plus `pieceLine` over the app's pieces. */
export function appGenerators(): Partial<Record<GeneratorId, Generator>> {
  generators ??= { ...GENERATORS, pieceLine: createPieceLine(appPieces()) };
  return generators;
}

/** What `composeSession` needs, beyond the learner and graph, to offer pieces. */
export function pieceInputs(): {
  pieces: readonly Piece[];
  generators: Partial<Record<GeneratorId, Generator>>;
} {
  return { pieces: appPieces(), generators: appGenerators() };
}

/** Generate an item with the app's generators (core ones and `pieceLine`). */
export function generatorFor(id: GeneratorId): Generator {
  const g = appGenerators()[id];
  if (g === undefined) throw new Error(`generator ${id} is not available`);
  return g;
}
