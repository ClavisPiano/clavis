import type { LearningEvent } from "../events/schema.js";
import { median } from "../grading/mastery.js";
import type { SkillGraph, Strand } from "../graph/schema.js";
import { learnerDay, type LearnerDay } from "../learning/day.js";
import { sessionSpans, uniqueById } from "./days.js";
import { weekStartOf } from "./weeks.js";

export const TREND_STRANDS: readonly Strand[] = ["EAR", "READ", "HANDS", "BYEAR", "APPLY"];

export interface TrendPoint {
  /** Monday of the ISO week, as a learner day. */
  week: LearnerDay;
  attempts: number;
  /** Share of attempts that passed, 0..1. */
  accuracy: number;
  /** Median latency of the passing attempts, undefined when there were none. */
  medianLatencyMs: number | undefined;
}

export interface StrandTrend {
  strand: Strand;
  /** Weeks with at least one attempt, oldest first. */
  points: TrendPoint[];
}

/**
 * Accuracy and median latency per strand per ISO week (Monday start), from attempts. The week is
 * the learner week of the attempt's session (that session's `tzOffsetMin`). Latency is taken from
 * passing attempts only, because a wrong or timed-out answer's latency says nothing about
 * fluency. Practice and Away attempts count. Placement writes no attempts. Attempts on nodes
 * missing from `graph` are ignored. Strands with no attempts are left out.
 */
export function fluencyTrends(events: readonly LearningEvent[], graph: SkillGraph): StrandTrend[] {
  const unique = uniqueById(events);
  const strandOf = new Map(graph.nodes.map((n) => [n.id, n.strand] as const));
  const tzOf = new Map(sessionSpans(unique).map((s) => [s.sessionId, s.tzOffsetMin] as const));
  const buckets = new Map<string, { passed: number; total: number; latencies: number[] }>();
  for (const e of unique) {
    if (e.type !== "attempt.completed") continue;
    const strand = strandOf.get(e.nodeId);
    const tz = tzOf.get(e.sessionId);
    if (strand === undefined || tz === undefined) continue;
    const week = weekStartOf(learnerDay(e.at, tz), 1);
    const key = `${strand}|${week}`;
    let b = buckets.get(key);
    if (!b) {
      b = { passed: 0, total: 0, latencies: [] };
      buckets.set(key, b);
    }
    b.total++;
    if (e.outcome.correct) {
      b.passed++;
      b.latencies.push(e.outcome.latencyMs);
    }
  }
  const out: StrandTrend[] = [];
  for (const strand of TREND_STRANDS) {
    const points: TrendPoint[] = [];
    for (const [key, b] of buckets) {
      const [s, week] = key.split("|");
      if (s !== strand || week === undefined) continue;
      points.push({
        week,
        attempts: b.total,
        accuracy: b.passed / b.total,
        medianLatencyMs: b.latencies.length > 0 ? median(b.latencies) : undefined,
      });
    }
    if (points.length === 0) continue;
    points.sort((a, b) => (a.week < b.week ? -1 : 1));
    out.push({ strand, points });
  }
  return out;
}
