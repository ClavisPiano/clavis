import type { SettingsPatch } from "../events/schema.js";
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
}

export interface LearnerState {
  cards: Record<string, CardRecord>;
  nodes: Record<string, NodeRecord>;
  attempts: Record<string, StoredAttempt[]>;
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
