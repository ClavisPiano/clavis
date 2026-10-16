import { describe, expect, it } from "vitest";
import { loadGraph } from "@clavis/content";
import type { SkillGraph, SkillNode, StoredAttempt } from "@clavis/core";
import {
  NODE_H,
  displayState,
  layoutSkillMap,
  nodeProgress,
  prerequisiteDepths,
  type SkillMapLayout,
} from "./skill-map";

const mastery = { minAccuracy: 0.9, windowAttempts: 4, distinctSessions: 2 };

function node(
  id: string,
  strand: SkillNode["strand"],
  prerequisites: string[] = [],
  extra: Partial<SkillNode> = {},
): SkillNode {
  return {
    id,
    strand,
    title: id.toUpperCase(),
    prerequisites,
    itemGenerators: ["degreeId"],
    params: {},
    mastery,
    keyDependent: false,
    ...extra,
  };
}

/** a -> b -> d, a -> c (READ), c + b -> e (cross strand), f is an unimplemented HANDS node. */
const graph: SkillGraph = {
  contentVersion: "t",
  generators: [
    { id: "degreeId", implemented: true, seedDurationSec: 5, awayEligible: true, requires: [] },
    { id: "coordTask", implemented: false, seedDurationSec: 5, awayEligible: false, requires: [] },
  ],
  nodes: [
    node("a", "EAR"),
    node("b", "EAR", ["a"]),
    node("c", "READ", ["a"]),
    node("d", "EAR", ["b"]),
    node("e", "READ", ["c", "b"]),
    node("f", "HANDS", ["e"], { itemGenerators: ["coordTask"] }),
    node("g", "EAR", ["a"], { softPrerequisites: ["d"] }),
  ],
};

const noState = { nodes: {} };

function rowOf(layout: SkillMapLayout, id: string): number {
  const n = layout.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`no node ${id}`);
  return n.row;
}

describe("prerequisiteDepths", () => {
  it("is 0 for roots and 1 + the deepest prerequisite otherwise, soft ones included", () => {
    const d = prerequisiteDepths(graph);
    expect(Object.fromEntries(d)).toEqual({ a: 0, b: 1, c: 1, d: 2, e: 2, f: 3, g: 3 });
  });
});

describe("layoutSkillMap", () => {
  it("puts every node in a deeper row than all its prerequisites (toy graph)", () => {
    const layout = layoutSkillMap(graph, noState, { showUnimplemented: true });
    for (const n of graph.nodes) {
      for (const p of [...n.prerequisites, ...(n.softPrerequisites ?? [])]) {
        expect(rowOf(layout, n.id)).toBeGreaterThan(rowOf(layout, p));
      }
    }
  });

  it("puts every node in a deeper row than all its prerequisites (shipped graph)", () => {
    const real = loadGraph();
    const layout = layoutSkillMap(real, noState, { showUnimplemented: true });
    expect(layout.nodes).toHaveLength(real.nodes.length);
    for (const n of real.nodes) {
      for (const p of [...n.prerequisites, ...(n.softPrerequisites ?? [])]) {
        expect(rowOf(layout, n.id)).toBeGreaterThan(rowOf(layout, p));
      }
    }
    // Every edge is drawn downward.
    const byId = new Map(layout.nodes.map((n) => [n.id, n] as const));
    for (const e of layout.edges) {
      expect(byId.get(e.to)?.y ?? 0).toBeGreaterThanOrEqual((byId.get(e.from)?.y ?? 0) + NODE_H);
    }
  });

  it("is deterministic", () => {
    const a = layoutSkillMap(graph, noState, { showUnimplemented: true });
    const b = layoutSkillMap(structuredClone(graph), structuredClone(noState), {
      showUnimplemented: true,
    });
    expect(b).toEqual(a);
    const real = loadGraph();
    expect(layoutSkillMap(real, noState)).toEqual(layoutSkillMap(loadGraph(), noState));
  });

  it("orders strand columns EAR, READ, HANDS and only for visible strands", () => {
    expect(layoutSkillMap(graph, noState).columns.map((c) => c.strand)).toEqual(["EAR", "READ"]);
    expect(
      layoutSkillMap(graph, noState, { showUnimplemented: true }).columns.map((c) => c.strand),
    ).toEqual(["EAR", "READ", "HANDS"]);
  });

  it("includes cross-strand edges and flags them", () => {
    const layout = layoutSkillMap(graph, noState);
    const cross = layout.edges.filter((e) => e.cross).map((e) => `${e.from}>${e.to}`);
    expect(cross.sort()).toEqual(["a>c", "b>e"]);
    expect(layout.edges.find((e) => e.from === "d" && e.to === "g")?.soft).toBe(true);
    expect(layout.edges).toHaveLength(7);
  });

  it("hides unimplemented nodes and their edges by default, shows them as later on request", () => {
    const hidden = layoutSkillMap(graph, noState);
    expect(hidden.nodes.map((n) => n.id)).not.toContain("f");
    expect(hidden.edges.some((e) => e.to === "f")).toBe(false);
    const shown = layoutSkillMap(graph, noState, { showUnimplemented: true });
    expect(shown.nodes.find((n) => n.id === "f")?.state).toBe("later");
    expect(shown.edges.some((e) => e.from === "e" && e.to === "f")).toBe(true);
  });

  it("keeps depth rows from the whole graph and compacts empty ones", () => {
    const layout = layoutSkillMap(graph, noState);
    // Depths 0, 1, 2, 3 are all used by implemented nodes here, so rows match depths.
    expect(layout.nodes.map((n) => [n.id, n.row, n.depth])).toEqual([
      ["a", 0, 0],
      ["b", 1, 1],
      ["c", 1, 1],
      ["d", 2, 2],
      ["e", 2, 2],
      ["g", 3, 3],
    ]);
  });

  it("keeps whole-graph depth when a middle node is hidden, and rows stay dense", () => {
    const g: SkillGraph = {
      ...graph,
      nodes: [
        node("x", "EAR"),
        node("y", "EAR", ["x"], { itemGenerators: ["coordTask"] }),
        node("z", "EAR", ["y"]),
      ],
    };
    const layout = layoutSkillMap(g, noState);
    expect(layout.nodes.map((n) => [n.id, n.row, n.depth])).toEqual([
      ["x", 0, 0],
      ["z", 1, 2],
    ]);
    expect(layout.edges).toEqual([]);
  });

  it("never overlaps two nodes", () => {
    const layout = layoutSkillMap(loadGraph(), noState, { showUnimplemented: true });
    const seen = new Set(layout.nodes.map((n) => `${String(n.x)},${String(n.y)}`));
    expect(seen.size).toBe(layout.nodes.length);
    for (const n of layout.nodes) {
      expect(n.y + NODE_H).toBeLessThanOrEqual(layout.height);
    }
  });

  it("reads node states, with locked as the default", () => {
    const layout = layoutSkillMap(
      graph,
      { nodes: { a: { state: "mastered" }, b: { state: "learning" } } },
      { showUnimplemented: true },
    );
    const states = Object.fromEntries(layout.nodes.map((n) => [n.id, n.state]));
    expect(states).toMatchObject({ a: "mastered", b: "learning", c: "locked", f: "later" });
  });
});

describe("displayState", () => {
  it("reports later for a node without an implemented generator", () => {
    const f = graph.nodes.find((n) => n.id === "f");
    if (!f) throw new Error("missing");
    expect(displayState(f, graph, { nodes: { f: { state: "available" } } })).toBe("later");
  });
});

describe("nodeProgress", () => {
  const n = node("a", "EAR");
  const at = (
    i: number,
    correct: boolean,
    mode: "instrument" | "away",
    s: string,
  ): StoredAttempt => ({
    at: i,
    sessionId: s,
    day: "2026-10-14",
    mode,
    correct,
    latencyMs: 1000 + i * 100,
  });

  it("is empty with no attempts", () => {
    expect(nodeProgress(n, { attempts: {} })).toEqual({
      attempts: 0,
      windowAttempts: 0,
      accuracy: undefined,
      medianLatencyMs: undefined,
      sessions: 0,
    });
  });

  it("measures the last window of instrument attempts and ignores Away", () => {
    const attempts = [
      at(0, false, "instrument", "s1"),
      at(1, true, "instrument", "s1"),
      at(2, true, "instrument", "s2"),
      at(3, true, "away", "s3"),
      at(4, false, "instrument", "s2"),
      at(5, true, "instrument", "s3"),
    ];
    // Window is 4: attempts 1, 2, 4, 5 -> 3 correct of 4, correct latencies 1100, 1200, 1500.
    expect(nodeProgress(n, { attempts: { a: attempts } })).toEqual({
      attempts: 6,
      windowAttempts: 4,
      accuracy: 0.75,
      medianLatencyMs: 1200,
      sessions: 3,
    });
  });
});
