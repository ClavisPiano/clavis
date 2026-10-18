import { cloneJson } from "./clone.js";
import { importedPiece } from "../events/learning.js";
import type { LearningEvent } from "../events/schema.js";
import { compareEvents } from "../events/validate.js";
import { combineFamilyStates } from "../grading/families.js";
import { evaluateNodeState, median, type GradedAttempt } from "../grading/mastery.js";
import { rate } from "../grading/rate.js";
import { MAX_DRILLS_PER_NODE, isDrillItemId } from "../items/drill.js";
import type { GeneratorId, NodeState, SkillGraph, SkillNode } from "../graph/schema.js";
import { isNodeEnabled } from "../graph/validate.js";
import type { JsonObject } from "../json.js";
import { learnerDay, type LearnerDay } from "../learning/day.js";
import { isValidKey, keyFamily, type KeyFamily } from "../theory/keys.js";
import type { Piece } from "../pieces/schema.js";
import type {
  DailyRecord,
  FoldContext,
  LearnerState,
  PresentationRecord,
  StoredAttempt,
} from "./types.js";

/** Bump whenever reducer semantics change. Snapshots from other versions are discarded (R8). */
export const REDUCER_VERSION = 7;

/** Weight of the newest attempt in a task's rolling score (spec 5.4, R27). */
export const TASK_ROLLING_ALPHA = 0.3;

/** Strands whose nodes are tasks, scheduled by task priority in Apply (spec 5.4, R27). */
export const TASK_STRANDS: readonly string[] = ["HANDS", "BYEAR"];

export const DURATION_WINDOW = 20;
/** Fewer samples than this and the graph seed is used instead of the median. */
export const MIN_DURATION_SAMPLES = 3;

const RANK: Record<NodeState, number> = {
  locked: 0,
  available: 1,
  learning: 2,
  fluent: 3,
  mastered: 4,
};

const nodeIndexCache = new WeakMap<SkillGraph, Map<string, SkillNode>>();
function nodeIndex(graph: SkillGraph): Map<string, SkillNode> {
  let idx = nodeIndexCache.get(graph);
  if (!idx) {
    idx = new Map(graph.nodes.map((n) => [n.id, n]));
    nodeIndexCache.set(graph, idx);
  }
  return idx;
}

/** Empty state with every graph node's availability computed. */
export function initialState(ctx: FoldContext): LearnerState {
  const state: LearnerState = {
    cards: {},
    nodes: {},
    attempts: {},
    pieces: {},
    imported: {},
    benchmarks: {},
    tasks: {},
    drills: {},
    sessions: {},
    presented: {},
    durations: {},
    daily: {},
    keyOfDayHistory: [],
    settings: {},
    eventCount: 0,
    warnings: 0,
  };
  for (const n of ctx.graph.nodes) state.nodes[n.id] = { state: "locked" };
  recomputeAvailability(state, ctx.graph);
  return state;
}

/**
 * Fold events into a state. Input order never matters: events are sorted by
 * (at, id) and duplicate ids are dropped (first occurrence wins).
 */
export function foldEvents(events: readonly LearningEvent[], ctx: FoldContext): LearnerState {
  return foldOnto(initialState(ctx), events, ctx);
}

/** Fold `events` onto an existing state (not mutated). Same sorting and dedupe as `foldEvents`. */
export function foldOnto(
  base: LearnerState,
  events: readonly LearningEvent[],
  ctx: FoldContext,
): LearnerState {
  const state = cloneJson(base);
  const seen = new Set<string>();
  const sorted: LearningEvent[] = [];
  for (const e of events) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    sorted.push(e);
  }
  sorted.sort(compareEvents);
  for (const e of sorted) reduceInPlace(state, e, ctx);
  return state;
}

/** Apply one event, returning a new state. The input state is not mutated. */
export function applyEvent(
  state: LearnerState,
  event: LearningEvent,
  ctx: FoldContext,
): LearnerState {
  const next = cloneJson(state);
  reduceInPlace(next, event, ctx);
  return next;
}

/** Rolling median seconds per presented item for a generator, or the graph seed when data is thin (R13). */
export function medianDurationSec(
  state: LearnerState,
  generator: GeneratorId,
  seedFromGraph: number,
): number {
  const xs = state.durations[generator];
  if (!xs || xs.length < MIN_DURATION_SAMPLES) return seedFromGraph;
  return median(xs);
}

function daily(state: LearnerState, day: string): DailyRecord {
  let d = state.daily[day];
  if (!d) {
    d = {
      newItems: 0,
      nodesIntroduced: 0,
      sessions: 0,
      practiceSec: 0,
      mode: { instrument: 0, away: 0 },
    };
    state.daily[day] = d;
  }
  return d;
}

function reduceInPlace(state: LearnerState, event: LearningEvent, ctx: FoldContext): void {
  state.eventCount++;
  state.lastEvent = { at: event.at, id: event.id };
  switch (event.type) {
    case "session.started": {
      if (state.sessions[event.sessionId]) return;
      const day = learnerDay(event.at, event.tzOffsetMin);
      state.sessions[event.sessionId] = {
        mode: event.mode,
        tzOffsetMin: event.tzOffsetMin,
        startedAt: event.at,
        day,
        key: { tonic: event.key.tonic, mode: event.key.mode },
        budgetSec: event.budgetSec,
        itemsPresented: 0,
        ...(event.practice ? { practice: true } : {}),
      };
      const d = daily(state, day);
      d.sessions++;
      d.mode[event.mode]++;
      if (!state.keyOfDayHistory.some((k) => k.day === day)) {
        state.keyOfDayHistory.push({ day, key: { tonic: event.key.tonic, mode: event.key.mode } });
      }
      return;
    }
    case "session.ended": {
      const s = state.sessions[event.sessionId];
      if (!s) {
        state.warnings++;
        return;
      }
      if (s.endedAt === undefined) {
        s.endedAt = event.at;
        const ms = Math.min(Math.max(0, event.at - s.startedAt), 2 * s.budgetSec * 1000);
        daily(state, s.day).practiceSec += ms / 1000;
      }
      const prefix = `${event.sessionId}:`;
      state.presented = Object.fromEntries(
        Object.entries(state.presented).filter(([k]) => !k.startsWith(prefix)),
      );
      return;
    }
    case "item.presented": {
      const rec: PresentationRecord = {
        nodeId: event.nodeId,
        generator: event.generator,
        at: event.at,
        ...keyHints(event.presentation),
        ...pieceHint(event.generator, event.presentation),
      };
      state.presented[`${event.sessionId}:${event.itemId}`] = rec;
      const s = state.sessions[event.sessionId];
      if (!s) {
        state.warnings++;
        return;
      }
      s.itemsPresented++;
      if (event.isNew) daily(state, s.day).newItems++;
      return;
    }
    case "attempt.completed":
      reduceAttempt(state, event, ctx);
      return;
    case "node.introduced": {
      const node = nodeIndex(ctx.graph).get(event.nodeId);
      const rec = state.nodes[event.nodeId];
      if (!node || !rec) {
        state.warnings++;
        return;
      }
      if (rec.state !== "available") {
        // Already introduced, or not yet unlocked: ignore, progress is never reset.
        if (rec.state === "locked") state.warnings++;
        return;
      }
      rec.state = "learning";
      rec.introducedAt = event.at;
      if (node.keyDependent && event.keyFamily) {
        rec.byFamily = { ...rec.byFamily, [event.keyFamily]: "learning" };
      }
      const s = state.sessions[event.sessionId];
      let day: string;
      if (s) day = s.day;
      else {
        state.warnings++;
        day = learnerDay(event.at, 0);
      }
      daily(state, day).nodesIntroduced++;
      reevaluate(state, node, event.at, day);
      recomputeAvailability(state, ctx.graph);
      return;
    }
    case "piece.completed": {
      const rec = (state.pieces[event.pieceId] ??= { phrases: {}, runs: 0 });
      rec.runs++;
      rec.lastRunAt = Math.max(rec.lastRunAt ?? event.at, event.at);
      if (event.correctPhrases === event.phrases) {
        rec.completedAt = Math.min(rec.completedAt ?? event.at, event.at);
      }
      return;
    }
    case "content.imported": {
      // Last write by (at, id) wins, whatever order the events arrive in.
      const prev = state.imported[event.pieceId];
      if (prev !== undefined && compareEvents({ at: prev.at, id: prev.eventId }, event) > 0) return;
      state.imported[event.pieceId] = {
        piece: cloneJson<Piece>(importedPiece(event)),
        source: event.source,
        partIndex: event.partIndex,
        staff: event.staff,
        at: event.at,
        eventId: event.id,
      };
      return;
    }
    case "benchmark.recorded": {
      // One per month: the last write by (at, id) wins, whatever order the events arrive in.
      const prev = state.benchmarks[event.month];
      if (prev !== undefined && compareEvents({ at: prev.at, id: prev.eventId }, event) > 0) return;
      state.benchmarks[event.month] = {
        benchmarkId: event.benchmarkId,
        pieceId: event.pieceId,
        month: event.month,
        blobKey: event.blobKey,
        contentType: event.contentType,
        durationMs: event.durationMs,
        sizeBytes: event.sizeBytes,
        at: event.at,
        eventId: event.id,
      };
      return;
    }
    case "placement.completed": {
      for (const [nodeId, result] of Object.entries(event.results)) {
        const node = nodeIndex(ctx.graph).get(nodeId);
        const rec = state.nodes[nodeId];
        if (!node || !rec) {
          state.warnings++;
          continue;
        }
        rec.placementFloor = result;
        if (result === "available") continue;
        if (RANK[result] > RANK[rec.state]) rec.state = result;
        if (node.keyDependent) {
          const by: Partial<Record<KeyFamily, NodeState>> = { ...rec.byFamily };
          for (const f of ["A", "B"] as const) {
            const cur = by[f];
            if (cur === undefined || RANK[result] > RANK[cur]) by[f] = result;
          }
          rec.byFamily = by;
        }
        reevaluate(state, node, event.at, learnerDay(event.at, 0));
      }
      recomputeAvailability(state, ctx.graph);
      return;
    }
    case "settings.changed": {
      for (const [k, v] of Object.entries(event.patch)) {
        if (v !== undefined) (state.settings as Record<string, unknown>)[k] = v;
      }
      return;
    }
    case "drill.spawned":
      reduceDrill(state, event, ctx);
      return;
    case "device.registered":
      return;
    default:
      // Unknown future event type: counted above, otherwise ignored.
      return;
  }
}

function reduceAttempt(
  state: LearnerState,
  event: Extract<LearningEvent, { type: "attempt.completed" }>,
  ctx: FoldContext,
): void {
  const node = nodeIndex(ctx.graph).get(event.nodeId);
  const session = state.sessions[event.sessionId];
  const pres = state.presented[`${event.sessionId}:${event.itemId}`];
  if (!node || !session || !pres) {
    state.warnings++;
    return;
  }

  const rating = rate(event.outcome, {
    mode: session.mode,
    ...(node.targetLatencyMs !== undefined ? { targetLatencyMs: node.targetLatencyMs } : {}),
  });
  // A drill item is a card only while it is live (T5.8): one pushed out by a newer drill, or
  // never spawned, still counts as evidence but gets no card back.
  const drill = isDrillItemId(event.itemId);
  const liveDrill = drill && (state.drills[event.nodeId] ?? []).includes(event.itemId);
  // Practice sessions (T2.15) count as evidence but never move the review schedule.
  if (!session.practice && (!drill || liveDrill)) {
    const existing = state.cards[event.itemId];
    const base = existing ? existing.card : ctx.scheduler.newCard(event.at);
    state.cards[event.itemId] = {
      nodeId: event.nodeId,
      card: ctx.scheduler.review(base, rating, event.at),
      lastAttemptAt: event.at,
      reps: (existing?.reps ?? 0) + 1,
    };
  }

  const attempt: StoredAttempt = {
    at: event.at,
    sessionId: event.sessionId,
    day: learnerDay(event.at, session.tzOffsetMin),
    mode: session.mode,
    correct: event.outcome.correct,
    latencyMs: event.outcome.latencyMs,
    ...(event.outcome.partial !== undefined ? { partial: event.outcome.partial } : {}),
  };
  if (node.keyDependent) {
    const tonic = pres.tonic ?? session.key.tonic;
    const mode = pres.mode ?? session.key.mode;
    const key = isValidKey({ tonic, mode }) ? { tonic, mode } : session.key;
    attempt.keyFamily = keyFamily(key);
  }
  (state.attempts[event.nodeId] ??= []).push(attempt);

  // Task priority (spec 5.4, R27): a HANDS or BYEAR node's own items, not its drills.
  if (TASK_STRANDS.includes(node.strand) && !drill) {
    const score = event.outcome.partial ?? (event.outcome.correct ? 1 : 0);
    const prev = state.tasks[event.nodeId];
    state.tasks[event.nodeId] = {
      lastPracticedAt: Math.max(prev?.lastPracticedAt ?? event.at, event.at),
      rolling:
        prev === undefined ? score : prev.rolling + TASK_ROLLING_ALPHA * (score - prev.rolling),
    };
  }

  if (pres.piece) {
    const piece = (state.pieces[pres.piece.id] ??= { phrases: {}, runs: 0 });
    const key = String(pres.piece.phrase);
    const phrase = (piece.phrases[key] ??= {
      attempts: 0,
      correct: 0,
      lastAt: 0,
      lastCorrect: false,
    });
    phrase.attempts++;
    if (event.outcome.correct) phrase.correct++;
    phrase.lastAt = event.at;
    phrase.lastCorrect = event.outcome.correct;
  }

  const secs = Math.max(0, event.at - pres.at) / 1000;
  const list = (state.durations[pres.generator] ??= []);
  list.push(secs);
  if (list.length > DURATION_WINDOW) list.splice(0, list.length - DURATION_WINDOW);

  reevaluate(state, node, event.at, attempt.day);
  recomputeAvailability(state, ctx.graph);
}

/**
 * Micro-drills (T5.8, R27). Each drill gets a fresh card due at the event's time, so the next
 * session plans it first. Choices beyond the spec:
 *
 * - At the cap (`MAX_DRILLS_PER_NODE` per node) a new drill retires the oldest one: its card is
 *   removed and it leaves `drills`, so the drills a node keeps are always its latest errors. Its
 *   attempts stay as evidence for the node.
 * - Spawning a drill that is already live keeps its card (memory state and history) but makes it
 *   due now if it was due later: the same change went wrong again.
 * - Drills in a practice session (T2.15) are ignored, as practice never moves a card. The session
 *   does not spawn them there anyway.
 */
function reduceDrill(
  state: LearnerState,
  event: Extract<LearningEvent, { type: "drill.spawned" }>,
  ctx: FoldContext,
): void {
  const node = nodeIndex(ctx.graph).get(event.nodeId);
  if (!node) {
    state.warnings++;
    return;
  }
  if (state.sessions[event.sessionId]?.practice) return;
  const live = (state.drills[event.nodeId] ??= []);
  for (const id of event.itemIds) {
    const existing = state.cards[id];
    if (live.includes(id) && existing) {
      if (existing.card.due > event.at) existing.card = { ...existing.card, due: event.at };
      continue;
    }
    if (!live.includes(id)) live.push(id);
    while (live.length > MAX_DRILLS_PER_NODE) {
      const retired = live.shift();
      if (retired !== undefined) {
        state.cards = Object.fromEntries(
          Object.entries(state.cards).filter(([k]) => k !== retired),
        );
      }
    }
    state.cards[id] = {
      nodeId: event.nodeId,
      card: ctx.scheduler.newCard(event.at),
      // No attempt yet: the spawn time stands in until the first one.
      lastAttemptAt: event.at,
      reps: 0,
    };
  }
}

/** The piece phrase a `pieceLine` presentation shows, when it names one. */
function pieceHint(generator: GeneratorId, p: JsonObject): Pick<PresentationRecord, "piece"> {
  if (generator !== "pieceLine") return {};
  const id = p.piece;
  const phrase = p.phrase;
  if (
    typeof id !== "string" ||
    typeof phrase !== "number" ||
    !Number.isInteger(phrase) ||
    phrase < 1
  ) {
    return {};
  }
  return { piece: { id, phrase } };
}

function keyHints(p: JsonObject): Pick<PresentationRecord, "tonic" | "mode"> {
  const out: { tonic?: string; mode?: "major" | "minor" } = {};
  const nested = p.key;
  const src: JsonObject =
    typeof nested === "object" && nested !== null && !Array.isArray(nested) ? nested : p;
  if (typeof src.tonic === "string") out.tonic = src.tonic;
  if (src.mode === "major" || src.mode === "minor") out.mode = src.mode;
  return out;
}

/** Re-evaluate one node from its attempt history. Locked and available nodes do not move. */
function reevaluate(state: LearnerState, node: SkillNode, at: number, day: LearnerDay): void {
  reevaluateState(state, node);
  // The first time a node is mastered is kept for good (T6.3): a later drop and regain leaves it.
  const rec = state.nodes[node.id];
  if (rec?.state === "mastered" && rec.firstMastered === undefined) {
    rec.firstMastered = { at, day };
  }
}

function reevaluateState(state: LearnerState, node: SkillNode): void {
  const rec = state.nodes[node.id];
  if (!rec || RANK[rec.state] < RANK.learning) return;
  const attempts = state.attempts[node.id] ?? [];
  if (!node.keyDependent) {
    rec.state = evaluateNodeState(rec.state, attempts, node.mastery);
    return;
  }
  const by: Partial<Record<KeyFamily, NodeState>> = { ...rec.byFamily };
  const families = new Set<KeyFamily>(Object.keys(by) as KeyFamily[]);
  for (const a of attempts) if (a.keyFamily) families.add(a.keyFamily);
  for (const f of families) {
    const own: GradedAttempt[] = attempts.filter((a) => a.keyFamily === f);
    by[f] = evaluateNodeState(by[f] ?? "learning", own, node.mastery);
  }
  rec.byFamily = by;
  rec.state = combineFamilyStates(by);
}

/**
 * Recompute locked/available for nodes that have not been introduced. A node
 * is available when it has an implemented generator, every hard prerequisite
 * is mastered and every soft prerequisite is at least learning (a placement
 * result lifts the prerequisite gate but not the generator requirement).
 *
 * Nodes at learning or beyond are never touched: progress is kept when a
 * prerequisite later demotes, and only new introductions are gated.
 */
function recomputeAvailability(state: LearnerState, graph: SkillGraph): void {
  for (const node of graph.nodes) {
    const rec = state.nodes[node.id];
    if (!rec || RANK[rec.state] >= RANK.learning) continue;
    const enabled = isNodeEnabled(node, graph.generators);
    const hardOk = node.prerequisites.every((p) => state.nodes[p]?.state === "mastered");
    const softOk = (node.softPrerequisites ?? []).every(
      (p) => RANK[state.nodes[p]?.state ?? "locked"] >= RANK.learning,
    );
    const placed = rec.placementFloor !== undefined;
    rec.state = enabled && (placed || (hardOk && softOk)) ? "available" : "locked";
  }
}
