import type { GeneratorId } from "../graph/schema.js";
import { bassMotion } from "./bass-motion.js";
import { bassNoteRead } from "./bass-note-read.js";
import { byEarPhrase } from "./by-ear-phrase.js";
import { cellEcho } from "./cell.js";
import { chordQuality } from "./chord-quality.js";
import { degreeId, degreeSing } from "./degree.js";
import { progressionId } from "./progression-id.js";
import { rhythmRead } from "./rhythm-read.js";
import { trebleNoteRead } from "./treble-note-read.js";
import { rhythmEcho } from "./rhythm.js";
import type { Generator } from "./types.js";

/** Implemented generators. Must stay in sync with `implemented: true` in the content graph. */
export const GENERATORS: Partial<Record<GeneratorId, Generator>> = {
  degreeSing,
  degreeId,
  cellEcho,
  rhythmEcho,
  rhythmRead,
  bassNoteRead,
  bassMotion,
  chordQuality,
  trebleNoteRead,
  progressionId,
  byEarPhrase,
};

export function getGenerator(id: GeneratorId): Generator {
  const g = GENERATORS[id];
  if (g === undefined) throw new Error(`generator ${id} is not implemented`);
  return g;
}
