import type { GeneratorId, SkillGraph } from "../graph/schema.js";
import type { SessionMode } from "../learning/rating.js";
import type { Generator, ItemParams } from "../items/types.js";
import type { Piece } from "../pieces/schema.js";
import type { LearnerState } from "../state/types.js";
import type { Key, KeyFamily } from "../theory/keys.js";

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
  /**
   * Generator registry. Defaults to `GENERATORS`. A node is enabled only when its generators are
   * implemented in the graph and present here, so tests can stub READ generators.
   */
  generators?: Partial<Record<GeneratorId, Generator>>;
  /**
   * Extra practice (T2.15): no introductions and no new items; every item that already has a card
   * in a node at learning or beyond is a candidate, weakest first, whether or not it is due.
   */
  practice?: boolean;
  /**
   * Learn more today: extra new items allowed in this plan on top of what is left of the daily
   * cap (the caller passes one batch, the `newItemsPerDay` setting). Nothing is stored, so it
   * applies to this plan only. Ignored for practice.
   */
  extraNewItems?: number;
  /**
   * The piece library (MP). With it, an enabled `pieceLine` generator in the registry and an
   * enabled APPLY node in the graph, an instrument session gets an Apply block of piece phrases
   * after Read. Without any of those the block is `null`.
   */
  pieces?: readonly Piece[];
}

/** One item the session runner will turn into a stimulus via `getGenerator(generator).generate(...)`. */
export interface PlannedItem {
  itemId: string;
  nodeId: string;
  generator: GeneratorId;
  params: ItemParams;
  isNew: boolean;
  estimatedSec: number;
  /** Key family of the item (R15). Present for key-dependent nodes only. */
  fam?: KeyFamily;
  /**
   * Key to present in (R15), from `keyForFamily`: the key of the day when it is in `fam` (and the
   * node's mode), else a seeded pick; C major (A minor) for family A until bass landmarks are
   * fluent. Present when `fam` is. The runner passes it as `preferredKey`.
   */
  key?: Key;
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
  /**
   * Apply holds piece phrases (MP) and is `null` when there are none: Away mode, practice, no
   * piece library or generator, or nothing due and nothing new to learn.
   */
  blocks: { ear: PlannedItem[]; read: PlannedItem[]; apply: PlannedItem[] | null };
  /** Present only for a whole-piece run (`composePieceRun`): the piece being played through. */
  run?: { pieceId: string };
  /** Node ids to introduce (emit `node.introduced`). At most one. */
  introductions: string[];
  /**
   * `keyFamily` to emit on `node.introduced`, by node id, for introduced key-dependent nodes
   * (always "A", R16). Empty for EAR introductions.
   */
  introductionKeyFamilies: Record<string, KeyFamily>;
  /** Present and true only for a practice plan. */
  practice?: true;
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
