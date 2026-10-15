import type { LearnerState, NodeState, SkillGraph, Strand } from "@clavis/core";

/** A skill the learner can pick for focused practice. */
export interface PracticeSkill {
  nodeId: string;
  title: string;
  strand: Strand;
  /** Items of this skill that have been answered at least once (the ones practice can repeat). */
  items: number;
}

/** Started skills: learning, fluent or mastered. */
const STARTED: ReadonlySet<NodeState> = new Set(["learning", "fluent", "mastered"]);

/**
 * Skills that practice can drill: started (learning or beyond) with at least one answered item,
 * in graph order. Practice repeats items that already have a card, so a skill with none is not
 * offered.
 */
export function practiceSkills(state: LearnerState, graph: SkillGraph): PracticeSkill[] {
  const counts = new Map<string, number>();
  for (const card of Object.values(state.cards)) {
    counts.set(card.nodeId, (counts.get(card.nodeId) ?? 0) + 1);
  }
  return graph.nodes.flatMap((node) => {
    const started = STARTED.has(state.nodes[node.id]?.state ?? "locked");
    const items = counts.get(node.id) ?? 0;
    return started && items > 0
      ? [{ nodeId: node.id, title: node.title, strand: node.strand, items }]
      : [];
  });
}

/** Query string for a practice session on the chosen skills; none chosen means all. */
export function practiceSearch(chosen: readonly string[], extra: { mode?: "away" } = {}): string {
  const q = new URLSearchParams({ practice: "1" });
  if (chosen.length > 0) q.set("skills", chosen.join(","));
  if (extra.mode) q.set("mode", extra.mode);
  return `?${q.toString()}`;
}
