import type { SessionMode } from "../learning/rating.js";

export const DEFAULT_BUDGET_SEC = { instrument: 720, away: 300 } as const;
/** Budgets at or below this are time pressured (spec 6.2). */
export const TIME_PRESSURE_SEC = 300;
export const MIN_ORIENT_SEC = 30;
/** Orient runs the scale only when it has at least this long. */
export const SCALE_ORIENT_SEC = 60;

/** Away mode shares when Read has Away-eligible content (R16). */
export const AWAY_SHARES = { ear: 0.6, read: 0.4 } as const;

export const BLOCK_SHARES = { orient: 0.1, ear: 0.3, read: 0.25, apply: 0.35 } as const;

export interface Allocation {
  orientSec: number;
  earSec: number;
  readSec: number;
  applySec: number;
  /** Seconds moved into ear from empty or dropped blocks. */
  reallocatedSec: number;
  notes: string[];
}

/**
 * Split a budget over the blocks (spec 6.1, 6.2). Away mode has no orient and is 60% ear and 40% read when read has content, else all ear. Blocks without content
 * give their share to ear. At 300 s or less apply is dropped first, then read is halved, and
 * orient is held to 30 s. All values are whole seconds that add up to the budget.
 */
export function allocate(opts: {
  budgetSec: number;
  mode: SessionMode;
  readHasContent: boolean;
  applyHasContent: boolean;
}): Allocation {
  const { budgetSec: b, mode } = opts;
  const notes: string[] = [];
  if (mode === "away") {
    if (!opts.readHasContent) {
      notes.push("away: ear only, orient skipped");
      return { orientSec: 0, earSec: b, readSec: 0, applySec: 0, reallocatedSec: 0, notes };
    }
    notes.push("away: ear 60%, read 40%, orient skipped");
    const readSec = Math.round(AWAY_SHARES.read * b);
    return { orientSec: 0, earSec: b - readSec, readSec, applySec: 0, reallocatedSec: 0, notes };
  }
  const pressure = b <= TIME_PRESSURE_SEC;
  let orient = BLOCK_SHARES.orient * b;
  let read = BLOCK_SHARES.read * b;
  let apply = BLOCK_SHARES.apply * b;
  let moved = 0;

  if (!opts.applyHasContent || pressure) {
    notes.push(pressure ? "time pressure: apply dropped" : "apply has no content");
    moved += apply;
    apply = 0;
  }
  if (!opts.readHasContent) {
    notes.push("read has no content");
    moved += read;
    read = 0;
  } else if (pressure) {
    notes.push("time pressure: read trimmed");
    moved += read / 2;
    read /= 2;
  }
  if (pressure) {
    const trimmed = Math.min(MIN_ORIENT_SEC, Math.floor(b / 3));
    orient = trimmed;
  }
  const orientSec = Math.round(orient);
  const readSec = Math.round(read);
  const applySec = Math.round(apply);
  return {
    orientSec,
    readSec,
    applySec,
    earSec: b - orientSec - readSec - applySec,
    reallocatedSec: Math.round(moved),
    notes,
  };
}
