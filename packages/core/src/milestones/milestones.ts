import type { SkillGraph } from "../graph/schema.js";
import type { LearnerDay } from "../learning/day.js";
import type { LearnerState } from "../state/types.js";
import type { Milestone } from "./schema.js";

/*
 * Capability milestones (T6.3). Pure functions of the folded state: `NodeRecord.firstMastered`
 * is set once by the reducer, so a node that drops from mastered and regains it keeps its first
 * date, and the same events in any order give the same milestones.
 */

export interface EarnedMilestone {
  nodeId: string;
  title: string;
  statement: string;
  /** Event time (ms since epoch) of the first mastery. */
  at: number;
  /** Learner day (R6) of the first mastery. */
  day: LearnerDay;
}

type NodesOf = Pick<LearnerState, "nodes">;

function statements(content: readonly Milestone[]): Map<string, string> {
  return new Map(content.map((m) => [m.nodeId, m.statement] as const));
}

/**
 * The milestones earned so far, oldest first (ties by graph order). Nodes with no statement in
 * `content` are skipped.
 */
export function milestones(
  state: NodesOf,
  graph: Pick<SkillGraph, "nodes">,
  content: readonly Milestone[],
): EarnedMilestone[] {
  const text = statements(content);
  const out: EarnedMilestone[] = [];
  for (const node of graph.nodes) {
    const statement = text.get(node.id);
    const first = state.nodes[node.id]?.firstMastered;
    if (statement === undefined || first === undefined) continue;
    out.push({ nodeId: node.id, title: node.title, statement, at: first.at, day: first.day });
  }
  // Array.prototype.sort is stable, so equal times keep graph order.
  return out.sort((a, b) => a.at - b.at);
}

/** Milestones earned in `after` that `before` had not earned yet, oldest first. */
export function newMilestones(
  before: NodesOf,
  after: NodesOf,
  graph: Pick<SkillGraph, "nodes">,
  content: readonly Milestone[],
): EarnedMilestone[] {
  return milestones(after, graph, content).filter(
    (m) => before.nodes[m.nodeId]?.firstMastered === undefined,
  );
}

export interface UpcomingMilestone {
  nodeId: string;
  title: string;
  statement: string;
  state: "learning" | "fluent";
}

/**
 * Milestones within reach: nodes the learner is working on (`fluent` or `learning`) that have
 * not been mastered yet. Fluent nodes come first, then graph order. At most `limit`.
 */
export function upcomingMilestones(
  state: NodesOf,
  graph: Pick<SkillGraph, "nodes">,
  content: readonly Milestone[],
  limit = 3,
): UpcomingMilestone[] {
  const text = statements(content);
  const out: UpcomingMilestone[] = [];
  for (const node of graph.nodes) {
    const statement = text.get(node.id);
    const rec = state.nodes[node.id];
    if (statement === undefined || !rec || rec.firstMastered !== undefined) continue;
    if (rec.state !== "learning" && rec.state !== "fluent") continue;
    out.push({ nodeId: node.id, title: node.title, statement, state: rec.state });
  }
  const ordered = [
    ...out.filter((m) => m.state === "fluent"),
    ...out.filter((m) => m.state === "learning"),
  ];
  return ordered.slice(0, limit);
}
