import type { GeneratorId, SkillGraph } from "../graph/schema.js";
import type { SessionMode } from "../learning/rating.js";
import type { ItemParams } from "../items/types.js";
import type { LearnerState } from "../state/types.js";
import type { Key } from "../theory/keys.js";

export interface ComposeInput {
  state: LearnerState;
  graph: SkillGraph;
  /** Injected clock, epoch ms. */
  now: number;
  /** Minutes east of UTC (R6). */
  tzOffsetMin: number;
  mode: SessionMode;
  /** Default 720 for instrument, 300 for away, or `settings.budgetSec` / `settings.awayBudgetSec`. */
  budgetSec?: number;
  seed: number;
}

/** One item the session runner will turn into a stimulus via `getGenerator(generator).generate(...)`. */
export interface PlannedItem {
  itemId: string;
  nodeId: string;
  generator: GeneratorId;
  params: ItemParams;
  isNew: boolean;
  estimatedSec: number;
}

export interface SessionPlan {
  /** Key of the day. */
  key: Key;
  mode: SessionMode;
  budgetSec: number;
  /** Orient estimate plus the sum of every planned item's estimate. */
  estimatedSec: number;
  /** Null in Away mode. */
  orient: { estimatedSec: number; includeScale: boolean } | null;
  /** Apply is always null until M5. */
  blocks: { ear: PlannedItem[]; read: PlannedItem[]; apply: null };
  /** Node ids to introduce (emit `node.introduced`). At most one. */
  introductions: string[];
  diagnostics: {
    /** Due cards found in the strands considered (ear plus read), before the budget cut. */
    dueCount: number;
    /** New items still allowed today when composing started. */
    newAllowance: number;
    /** Seconds moved into the ear block from blocks that had no content or were dropped for time. */
    reallocatedSec: number;
    notes: string[];
  };
}
