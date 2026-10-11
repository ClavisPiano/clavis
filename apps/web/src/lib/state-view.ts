import {
  dayNumberToIso,
  learnerDayNumber,
  medianDurationSec,
  overdueness,
  rankDue,
  windowAccuracy,
  type DailyRecord,
  type LearnerState,
  type SkillGraph,
} from "@clavis/core";

/* Pure derivations for the /dev/state page. */

export interface NodeRow {
  id: string;
  strand: string;
  state: string;
  families: string;
  introducedAt: number | undefined;
  attempts: number;
  windowAccuracy: number | undefined;
}

export function nodeRows(state: LearnerState, graph: SkillGraph): NodeRow[] {
  return graph.nodes.map((node) => {
    const rec = state.nodes[node.id];
    const attempts = state.attempts[node.id] ?? [];
    const families = rec?.byFamily
      ? Object.entries(rec.byFamily)
          .map(([f, s]) => `${f}:${s}`)
          .join(" ")
      : "";
    return {
      id: node.id,
      strand: node.strand,
      state: rec?.state ?? "locked",
      families,
      introducedAt: rec?.introducedAt,
      attempts: attempts.length,
      windowAccuracy:
        attempts.length === 0 ? undefined : windowAccuracy(attempts, node.mastery.windowAttempts),
    };
  });
}

export interface DueRow {
  itemId: string;
  nodeId: string;
  due: number;
  overdueness: number;
  stability: number;
}

export function dueRows(state: LearnerState, now: number): DueRow[] {
  const items = Object.entries(state.cards).map(([itemId, rec]) => ({
    itemId,
    nodeId: rec.nodeId,
    card: rec.card,
  }));
  return rankDue(items, now).map((i) => ({
    itemId: i.itemId,
    nodeId: i.nodeId,
    due: i.card.due,
    overdueness: overdueness(i.card, now),
    stability: i.card.stability,
  }));
}

const EMPTY_DAY: DailyRecord = {
  newItems: 0,
  nodesIntroduced: 0,
  sessions: 0,
  practiceSec: 0,
  mode: { instrument: 0, away: 0 },
};

/** The `count` learner days ending at the day containing `now`, newest first, zero-filled. */
export function recentDays(
  state: LearnerState,
  now: number,
  tzOffsetMin: number,
  count = 7,
): { day: string; record: DailyRecord }[] {
  const today = learnerDayNumber(now, tzOffsetMin);
  return Array.from({ length: count }, (_, i) => {
    const day = dayNumberToIso(today - i);
    return { day, record: state.daily[day] ?? EMPTY_DAY };
  });
}

export function durationRows(
  state: LearnerState,
  graph: SkillGraph,
): { generator: string; medianSec: number; samples: number; implemented: boolean }[] {
  return graph.generators.map((g) => ({
    generator: g.id,
    medianSec: medianDurationSec(state, g.id, g.seedDurationSec),
    samples: state.durations[g.id]?.length ?? 0,
    implemented: g.implemented,
  }));
}
