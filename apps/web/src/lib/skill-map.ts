import {
  isNodeEnabled,
  median,
  windowAccuracy,
  type LearnerState,
  type NodeState,
  type SkillGraph,
  type SkillNode,
  type Strand,
} from "@clavis/core";

/*
 * View model for the skill map (T6.2, spec 3 and 14). Pure: the graph and the learner's node
 * states go in, node boxes and edges come out. The page only draws them.
 */

/** Strand column order, left to right. Strands with no visible node get no column. */
export const STRAND_ORDER: readonly Strand[] = ["EAR", "READ", "HANDS", "BYEAR", "APPLY"];

export const NODE_W = 148;
export const NODE_H = 64;
export const COL_GAP = 28;
export const ROW_GAP = 28;
export const PAD = 12;
/** Room above the first row for the strand headings. */
export const HEADER_H = 24;

/** A node state, or `later` for a node with no implemented generator yet. */
export type DisplayState = NodeState | "later";

export const STATE_LABEL: Record<DisplayState, string> = {
  locked: "Locked",
  available: "Available",
  learning: "Learning",
  fluent: "Fluent",
  mastered: "Mastered",
  later: "Coming later",
};

/** Text glyph per state, so colour is never the only signal. */
export const STATE_GLYPH: Record<DisplayState, string> = {
  locked: "◌",
  available: "○",
  learning: "◐",
  fluent: "◑",
  mastered: "✓",
  later: "…",
};

export interface MapNode {
  id: string;
  title: string;
  strand: Strand;
  /** Column index into `columns`. */
  col: number;
  /** Dense row index: deeper in the prerequisite chain means a larger row. */
  row: number;
  /** Prerequisite depth within the whole graph (0 for a root). */
  depth: number;
  /** Place within a cell that holds several nodes. */
  slot: number;
  x: number;
  y: number;
  state: DisplayState;
}

export interface MapEdge {
  from: string;
  to: string;
  /** Soft prerequisite (needs to be at least learning). */
  soft: boolean;
  /** The two nodes sit in different strands. */
  cross: boolean;
  /** SVG path data from the bottom of `from` to the top of `to`. */
  d: string;
}

export interface MapColumn {
  strand: Strand;
  x: number;
}

export interface SkillMapLayout {
  columns: MapColumn[];
  nodes: MapNode[];
  edges: MapEdge[];
  width: number;
  height: number;
}

export interface LayoutOptions {
  /** Draw nodes with no implemented generator, dimmed. Default false. */
  showUnimplemented?: boolean;
}

/**
 * Prerequisite depth of every node: 0 for a root, else 1 + the deepest prerequisite (hard or
 * soft, so every edge points to a deeper row). Computed over the whole graph, whatever is shown.
 */
export function prerequisiteDepths(graph: SkillGraph): Map<string, number> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const known = depths.get(id);
    if (known !== undefined) return known;
    const node = byId.get(id);
    // A dangling id or a cycle cannot happen in a validated graph; treat it as a root.
    if (!node || visiting.has(id)) return 0;
    visiting.add(id);
    let d = 0;
    for (const p of [...node.prerequisites, ...(node.softPrerequisites ?? [])]) {
      if (byId.has(p)) d = Math.max(d, depthOf(p) + 1);
    }
    visiting.delete(id);
    depths.set(id, d);
    return d;
  };
  for (const n of graph.nodes) depthOf(n.id);
  return depths;
}

/** The state shown for a node: the learner's state, `locked` when never evaluated. */
export function displayState(
  node: SkillNode,
  graph: SkillGraph,
  state: Pick<LearnerState, "nodes">,
): DisplayState {
  if (!isNodeEnabled(node, graph.generators)) return "later";
  return state.nodes[node.id]?.state ?? "locked";
}

/**
 * Lay the graph out: one column per strand (in `STRAND_ORDER`), one row per distinct prerequisite
 * depth among the visible nodes. Nodes that share a strand and depth stack in graph order.
 * Deterministic: the same input always gives the same output.
 */
export function layoutSkillMap(
  graph: SkillGraph,
  state: Pick<LearnerState, "nodes">,
  options: LayoutOptions = {},
): SkillMapLayout {
  const depths = prerequisiteDepths(graph);
  const visible = graph.nodes.filter(
    (n) => options.showUnimplemented === true || isNodeEnabled(n, graph.generators),
  );
  const strands = STRAND_ORDER.filter((s) => visible.some((n) => n.strand === s));
  const usedDepths = [...new Set(visible.map((n) => depths.get(n.id) ?? 0))].sort((a, b) => a - b);

  const slotCount = new Map<string, number>();
  const placed = visible.map((n) => {
    const depth = depths.get(n.id) ?? 0;
    const col = strands.indexOf(n.strand);
    const row = usedDepths.indexOf(depth);
    const cell = `${String(col)}:${String(row)}`;
    const slot = slotCount.get(cell) ?? 0;
    slotCount.set(cell, slot + 1);
    return { node: n, depth, col, row, slot };
  });

  // A row is as tall as its fullest cell.
  const rowSlots = usedDepths.map(() => 1);
  for (const p of placed) rowSlots[p.row] = Math.max(rowSlots[p.row] ?? 1, p.slot + 1);
  const rowTop: number[] = [];
  let y = PAD + HEADER_H;
  for (const slots of rowSlots) {
    rowTop.push(y);
    y += slots * (NODE_H + ROW_GAP);
  }

  const colX = (col: number): number => PAD + col * (NODE_W + COL_GAP);
  const nodes: MapNode[] = placed.map((p) => ({
    id: p.node.id,
    title: p.node.title,
    strand: p.node.strand,
    col: p.col,
    row: p.row,
    depth: p.depth,
    slot: p.slot,
    x: colX(p.col),
    y: (rowTop[p.row] ?? PAD + HEADER_H) + p.slot * (NODE_H + ROW_GAP),
    state: displayState(p.node, graph, state),
  }));
  const byId = new Map(nodes.map((n) => [n.id, n] as const));

  const edges: MapEdge[] = [];
  for (const n of visible) {
    const to = byId.get(n.id);
    if (!to) continue;
    const list = [
      ...n.prerequisites.map((id) => ({ id, soft: false })),
      ...(n.softPrerequisites ?? []).map((id) => ({ id, soft: true })),
    ];
    for (const { id, soft } of list) {
      const from = byId.get(id);
      if (!from) continue;
      const x1 = from.x + NODE_W / 2;
      const y1 = from.y + NODE_H;
      const x2 = to.x + NODE_W / 2;
      const y2 = to.y;
      const mid = (y1 + y2) / 2;
      edges.push({
        from: id,
        to: n.id,
        soft,
        cross: from.strand !== to.strand,
        d: `M${String(x1)} ${String(y1)} C${String(x1)} ${String(mid)} ${String(x2)} ${String(mid)} ${String(x2)} ${String(y2)}`,
      });
    }
  }

  return {
    columns: strands.map((strand, i) => ({ strand, x: colX(i) })),
    nodes,
    edges,
    width: PAD * 2 + strands.length * NODE_W + Math.max(0, strands.length - 1) * COL_GAP,
    height: y - ROW_GAP + PAD,
  };
}

export interface NodeProgress {
  /** All graded attempts on the node. */
  attempts: number;
  /** Attempts in the mastery window (instrument mode only, like mastery itself). */
  windowAttempts: number;
  /** Accuracy over the window, undefined with no attempts. */
  accuracy: number | undefined;
  /** Median latency of correct answers in the window, undefined with none. */
  medianLatencyMs: number | undefined;
  /** Distinct sessions in the window. */
  sessions: number;
}

/**
 * Progress toward a node's mastery criteria, measured the way `masteredConditionMet` does:
 * the last `windowAttempts` instrument attempts. Away attempts never count toward mastery (R3).
 */
export function nodeProgress(node: SkillNode, state: Pick<LearnerState, "attempts">): NodeProgress {
  const all = state.attempts[node.id] ?? [];
  const inst = all.filter((a) => a.mode === "instrument");
  const window = inst.slice(Math.max(0, inst.length - node.mastery.windowAttempts));
  const correct = window.filter((a) => a.correct).map((a) => a.latencyMs);
  return {
    attempts: all.length,
    windowAttempts: window.length,
    accuracy: window.length === 0 ? undefined : windowAccuracy(window, node.mastery.windowAttempts),
    medianLatencyMs: correct.length === 0 ? undefined : median(correct),
    sessions: new Set(window.map((a) => a.sessionId)).size,
  };
}
