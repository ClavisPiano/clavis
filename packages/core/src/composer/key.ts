import { learnerDay, learnerDayNumber } from "../learning/day.js";
import type { NodeState, SkillGraph } from "../graph/schema.js";
import type { LearnerState } from "../state/types.js";
import {
  canonicalKey,
  circleOfFifthsNext,
  isValidKey,
  keyFamily,
  relativeMajor,
  relativeMinor,
  type Key,
  type KeyFamily,
} from "../theory/keys.js";

export const FIRST_KEY: Key = { tonic: "C", mode: "major" };

export const NODE_RANK: Record<NodeState, number> = {
  locked: 0,
  available: 1,
  learning: 2,
  fluent: 3,
  mastered: 4,
};

/**
 * Key families open for the key of the day (spec 3.4, 6.3). A is always open. B opens once any
 * key-dependent node is mastered in A. C opens once any key-dependent node is fluent (or better)
 * in B, which also keeps B open.
 */
export function unlockedFamilies(state: LearnerState, graph: SkillGraph): KeyFamily[] {
  const by = (nodeId: string, f: KeyFamily): NodeState | undefined =>
    state.nodes[nodeId]?.byFamily?.[f];
  const kd = graph.nodes.filter((n) => n.keyDependent);
  const b = kd.some((n) => by(n.id, "A") === "mastered");
  const c = kd.some((n) => {
    const s = by(n.id, "B");
    return s !== undefined && NODE_RANK[s] >= NODE_RANK.fluent;
  });
  return c ? ["A", "B", "C"] : b ? ["A", "B"] : ["A"];
}

/** True when a minor-mode EAR node is learning or beyond (spec 6.3: minor days start here). */
function minorEarStarted(state: LearnerState, graph: SkillGraph): boolean {
  return graph.nodes.some(
    (n) =>
      n.strand === "EAR" &&
      n.params.mode === "minor" &&
      NODE_RANK[state.nodes[n.id]?.state ?? "locked"] >= NODE_RANK.learning,
  );
}

/**
 * Key of the day. Reuses today's entry in `keyOfDayHistory` when present. Otherwise rotates the
 * most recent earlier key one step round the circle of fifths (in major terms, so a minor day
 * rotates its relative major) until the key sits in an unlocked family. Minor is chosen on odd
 * learner day numbers once a minor-mode EAR node is learning. First ever key is C major.
 */
export function keyOfDay(
  state: LearnerState,
  graph: SkillGraph,
  now: number,
  tzOffsetMin: number,
): Key {
  const today = learnerDay(now, tzOffsetMin);
  const existing = state.keyOfDayHistory.find((k) => k.day === today);
  if (existing && isValidKey(existing.key)) {
    return { tonic: existing.key.tonic, mode: existing.key.mode };
  }

  let prev: { day: string; key: Key } | undefined;
  for (const entry of state.keyOfDayHistory) {
    if (entry.day >= today || !isValidKey(entry.key)) continue;
    if (!prev || entry.day >= prev.day) prev = entry;
  }
  const wantMinor = minorEarStarted(state, graph) && learnerDayNumber(now, tzOffsetMin) % 2 !== 0;
  if (!prev) return wantMinor ? relativeMinor(FIRST_KEY) : { ...FIRST_KEY };

  const families = unlockedFamilies(state, graph);
  let major = relativeMajor(canonicalKey(prev.key));
  for (let i = 0; i < 12; i++) {
    major = circleOfFifthsNext(major);
    if (families.includes(keyFamily(major))) break;
  }
  if (!families.includes(keyFamily(major))) major = { ...FIRST_KEY };
  return wantMinor ? relativeMinor(major) : major;
}
