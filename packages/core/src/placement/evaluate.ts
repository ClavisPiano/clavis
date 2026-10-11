import { median } from "../grading/mastery.js";
import type { SkillGraph } from "../graph/schema.js";
import type { PlacementAttempt, PlacementSection, PlacementState, StageOutcome } from "./types.js";

/*
 * Placement rules (R19). Everything here is pure and works on stage specs, so the plan and the
 * evaluator cannot drift apart.
 *
 * EAR stages ("ear" rule), n items: mastered needs at least n-1 correct and a median latency of the
 * correct answers within the target; fluent is at least n-2 correct. For the 9 item stage that is
 * R19's 8+/7, for the 8 item diatonic stage it is 7+/6. R19 says "the same rule" for the diatonic
 * stage without numbers; the n-1 / n-2 reading is ours and needs the owner's confirmation.
 * A stage with n-1 correct but a slow median is fluent, not mastered.
 *
 * READ stages ("read" rule), per node: mastered needs every item correct and within its target
 * latency; fluent is at least n-1 correct (3 of 4, 2 of 3) with no latency condition.
 *
 * Gating: the diatonic stage runs only if 1-3-5 is mastered. A READ stage runs only if the previous
 * READ stage is at least fluent (the section stops at the first available). The EAR 1-3-5 stage
 * scoring available stops the EAR section. The sections are independent.
 */

export interface StageSpec {
  id: string;
  section: PlacementSection;
  nodeId: string;
  rule: "ear" | "read";
  size: number;
  /** The previous stage in the section must reach at least this state for the stage to run. */
  gate: PlacementState | null;
}

export const STAGE_SPECS: readonly StageSpec[] = [
  {
    id: "ear.135",
    section: "EAR",
    nodeId: "ear.degrees.major.135",
    rule: "ear",
    size: 9,
    gate: null,
  },
  {
    id: "ear.diatonic",
    section: "EAR",
    nodeId: "ear.degrees.major.diatonic",
    rule: "ear",
    size: 8,
    gate: "mastered",
  },
  {
    id: "read.landmarks",
    section: "READ",
    nodeId: "read.bass.landmarks",
    rule: "read",
    size: 4,
    gate: null,
  },
  {
    id: "read.steps",
    section: "READ",
    nodeId: "read.bass.steps",
    rule: "read",
    size: 3,
    gate: "fluent",
  },
  {
    id: "read.skips",
    section: "READ",
    nodeId: "read.bass.skips",
    rule: "read",
    size: 3,
    gate: "fluent",
  },
];

const RANK: Record<PlacementState, number> = { available: 0, fluent: 1, mastered: 2 };

export function atLeast(state: PlacementState, floor: PlacementState): boolean {
  return RANK[state] >= RANK[floor];
}

export function minState(a: PlacementState, b: PlacementState): PlacementState {
  return RANK[a] <= RANK[b] ? a : b;
}

/** Raise-only merge (R5): the higher of the current and placed states. */
export function mergePlacement(
  current: PlacementState | undefined,
  placed: PlacementState,
): PlacementState {
  return current === undefined ? placed : RANK[placed] > RANK[current] ? placed : current;
}

/** Median latency of the correct answers against their median target (targets are equal per node). */
function medianWithinTarget(correct: readonly PlacementAttempt[]): boolean {
  const target = median(correct.map((a) => a.targetLatencyMs));
  return median(correct.map((a) => a.latencyMs)) <= target;
}

/** Score one complete stage. `attempts` must hold exactly `spec.size` entries. */
export function scoreStage(spec: StageSpec, attempts: readonly PlacementAttempt[]): PlacementState {
  const n = spec.size;
  const correct = attempts.filter((a) => a.correct);
  const c = correct.length;
  if (spec.rule === "ear") {
    if (c >= n - 1 && medianWithinTarget(correct)) return "mastered";
    if (c >= n - 2) return "fluent";
    return "available";
  }
  if (c === n && attempts.every((a) => a.latencyMs <= a.targetLatencyMs)) return "mastered";
  if (c >= n - 1) return "fluent";
  return "available";
}

export interface Progress {
  completed: StageOutcome[];
  /** The stage in progress and how many of its items are answered; null when all is done. */
  current: { spec: StageSpec; answered: number } | null;
  skipped: StageSpec[];
}

/**
 * Walk the stages in order, consuming attempts by node id (the first `size` attempts of a node
 * belong to its stage; later ones are ignored). Stops at the first stage that is not complete.
 */
export function walk(attempts: readonly PlacementAttempt[]): Progress {
  const completed: StageOutcome[] = [];
  const skipped: StageSpec[] = [];
  const stopped = new Set<PlacementSection>();
  for (const spec of STAGE_SPECS) {
    if (stopped.has(spec.section)) {
      skipped.push(spec);
      continue;
    }
    if (spec.gate !== null) {
      const prev = [...completed].reverse().find((o) => o.section === spec.section);
      if (prev === undefined || !atLeast(prev.state, spec.gate)) {
        stopped.add(spec.section);
        skipped.push(spec);
        continue;
      }
    }
    const mine = attempts.filter((a) => a.nodeId === spec.nodeId).slice(0, spec.size);
    if (mine.length < spec.size) {
      return { completed, current: { spec, answered: mine.length }, skipped };
    }
    const state = scoreStage(spec, mine);
    completed.push({ stageId: spec.id, nodeId: spec.nodeId, section: spec.section, state });
    if (state === "available") stopped.add(spec.section);
  }
  return { completed, current: null, skipped };
}

/**
 * Per-node placed state, capped by prerequisites: a node never exceeds the lowest placed state of
 * its prerequisites. Prerequisites that were not placed do not cap. Unreached or incomplete nodes
 * have no entry.
 */
export function placementResults(
  attempts: readonly PlacementAttempt[],
  graph: SkillGraph,
): Record<string, PlacementState> {
  const raw = new Map(walk(attempts).completed.map((o) => [o.nodeId, o.state]));
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const memo = new Map<string, PlacementState | undefined>();
  const resolve = (id: string, seen: Set<string>): PlacementState | undefined => {
    if (memo.has(id)) return memo.get(id);
    const own = raw.get(id);
    if (own === undefined || seen.has(id)) return undefined;
    seen.add(id);
    let state = own;
    for (const p of byId.get(id)?.prerequisites ?? []) {
      const ps = resolve(p, seen);
      if (ps !== undefined) state = minState(state, ps);
    }
    seen.delete(id);
    memo.set(id, state);
    return state;
  };
  const out: Record<string, PlacementState> = {};
  for (const id of raw.keys()) {
    const s = resolve(id, new Set());
    if (s !== undefined) out[id] = s;
  }
  return out;
}
