import type { SettingsPatch } from "../events/schema.js";
import type { Piece } from "../pieces/schema.js";
import type { GradedAttempt } from "../grading/mastery.js";
import type { GeneratorId, NodeState, SkillGraph } from "../graph/schema.js";
import type { LearnerDay } from "../learning/day.js";
import type { SessionMode } from "../learning/rating.js";
import type { CardState } from "../scheduler/card.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import type { Key, KeyFamily } from "../theory/keys.js";

/*
 * Derived learner state. Plain JSON only (no Maps, Dates or class instances,
 * and no `undefined` valued properties) so it survives a snapshot round trip
 * unchanged.
 */

export interface CardRecord {
  nodeId: string;
  card: CardState;
  lastAttemptAt: number;
  /** Number of reviews applied to this card. */
  reps: number;
}

export interface NodeRecord {
  state: NodeState;
  /** Present for key-dependent nodes once a family has been evaluated or placed. */
  byFamily?: Partial<Record<KeyFamily, NodeState>>;
  introducedAt?: number;
  placementFloor?: NodeState;
  /**
   * When the node first reached `mastered`: the event time and learner day (T6.3). Set once and
   * never cleared, so a drop and a regain keep the first date. Placement counts, on the day of the
   * placement event read at UTC.
   */
  firstMastered?: { at: number; day: LearnerDay };
}

/** A graded attempt plus the key family it was played in (key-dependent nodes only). */
export interface StoredAttempt extends GradedAttempt {
  keyFamily?: KeyFamily;
}

export interface SessionRecord {
  mode: SessionMode;
  tzOffsetMin: number;
  startedAt: number;
  endedAt?: number;
  day: LearnerDay;
  key: Key;
  budgetSec: number;
  itemsPresented: number;
  /** Extra practice (T2.15): attempts are evidence only, FSRS cards are untouched. */
  practice?: boolean;
}

export interface DailyRecord {
  newItems: number;
  nodesIntroduced: number;
  sessions: number;
  practiceSec: number;
  /** Sessions started per mode. */
  mode: { instrument: number; away: number };
}

/** What `item.presented` leaves behind until the session ends. */
export interface PresentationRecord {
  nodeId: string;
  generator: GeneratorId;
  at: number;
  /** Key hints from the presentation params, when present. */
  tonic?: string;
  mode?: "major" | "minor";
  /** The piece phrase a `pieceLine` item shows (MP). */
  piece?: { id: string; phrase: number };
}

/** What the learner has done with one phrase of a piece, from its attempts. */
export interface PhraseRecord {
  attempts: number;
  correct: number;
  lastAt: number;
  lastCorrect: boolean;
}

/** Progress on one piece (MP), derived from phrase attempts and `piece.completed` events. */
export interface PieceRecord {
  /** By phrase number, 1-based, as a string key so the state stays plain JSON. */
  phrases: Record<string, PhraseRecord>;
  /** Whole-piece runs finished, whatever their result. */
  runs: number;
  lastRunAt?: number;
  /** When a run first had every phrase correct: the piece has been played through. */
  completedAt?: number;
}

/** A piece the learner imported (T7.4), as the latest `content.imported` event for its id left it. */
export interface ImportedPieceRecord {
  piece: Piece;
  source: "musicxml" | "mxl";
  partIndex: number;
  staff: number;
  /** The `(at, id)` of the event that wrote this record: the later one wins. */
  at: number;
  eventId: string;
}

/** The benchmark kept for one month (T6.5, R28): the latest `benchmark.recorded` for it. */
export interface BenchmarkRecord {
  benchmarkId: string;
  pieceId: string;
  /** Learner-local month, "YYYY-MM". */
  month: string;
  blobKey: string;
  contentType: string;
  durationMs: number;
  sizeBytes: number;
  /** The `(at, id)` of the event that wrote this record: the later one wins. */
  at: number;
  eventId: string;
}

/**
 * Task-level progress on one HANDS or BYEAR node (spec 5.4, R27), from its attempts. Drill
 * attempts are left out: a drill is not the task.
 */
export interface TaskRecord {
  /** The latest attempt at one of the node's items. */
  lastPracticedAt: number;
  /**
   * Exponentially weighted mean (alpha `TASK_ROLLING_ALPHA`) of each attempt's `partial`, or 1
   * and 0 for a correct and a wrong attempt without one. The first attempt sets it outright.
   */
  rolling: number;
}

export interface LearnerState {
  cards: Record<string, CardRecord>;
  nodes: Record<string, NodeRecord>;
  attempts: Record<string, StoredAttempt[]>;
  /** Piece progress by piece id (MP). */
  pieces: Record<string, PieceRecord>;
  /** Pieces the learner imported, by piece id (T7.4). Unlocked from the start, see `listPieces`. */
  imported: Record<string, ImportedPieceRecord>;
  /** Monthly benchmarks by month ("YYYY-MM"), one per month (T6.5). */
  benchmarks: Record<string, BenchmarkRecord>;
  /** Task priority inputs for HANDS and BYEAR nodes, by node id (T5.8). */
  tasks: Record<string, TaskRecord>;
  /**
   * Live micro-drill item ids by node id, oldest first (T5.8), at most `MAX_DRILLS_PER_NODE`.
   * Each has a card in `cards`; a drill pushed out by a newer one loses its card.
   */
  drills: Record<string, string[]>;
  sessions: Record<string, SessionRecord>;
  /** Key `${sessionId}:${itemId}`. Pruned when the session ends. */
  presented: Record<string, PresentationRecord>;
  /** Last 20 presented to completed durations per generator, in seconds. */
  durations: Partial<Record<GeneratorId, number[]>>;
  daily: Record<LearnerDay, DailyRecord>;
  keyOfDayHistory: { day: LearnerDay; key: Key }[];
  settings: SettingsPatch;
  lastEvent?: { at: number; id: string };
  eventCount: number;
  /** Events that could not be fully applied (missing session or presentation, unknown node). */
  warnings: number;
}

export interface FoldContext {
  graph: SkillGraph;
  scheduler: Scheduler;
}
