import type { GeneratorId } from "../graph/schema.js";
import { cellEcho } from "./cell.js";
import { degreeId, degreeSing } from "./degree.js";
import { rhythmEcho } from "./rhythm.js";
import type { Generator } from "./types.js";

/** Implemented generators. Must stay in sync with `implemented: true` in the content graph. */
export const GENERATORS: Partial<Record<GeneratorId, Generator>> = {
  degreeSing,
  degreeId,
  cellEcho,
  rhythmEcho,
};

export function getGenerator(id: GeneratorId): Generator {
  const g = GENERATORS[id];
  if (g === undefined) throw new Error(`generator ${id} is not implemented`);
  return g;
}
