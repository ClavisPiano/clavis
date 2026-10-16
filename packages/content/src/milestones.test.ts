import { describe, expect, it } from "vitest";
import { isNodeEnabled, MAX_MILESTONE_CHARS } from "@clavis/core";
import {
  loadGraph,
  loadMilestones,
  MILESTONE_EXEMPT,
  milestoneForNode,
  parseMilestones,
} from "./index";

describe("capability milestones v1", () => {
  const milestones = loadMilestones();
  const graph = loadGraph();

  it("has at most one statement per node", () => {
    const ids = milestones.map((m) => m.nodeId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("only references nodes in the graph", () => {
    const ids = new Set(graph.nodes.map((n) => n.id));
    for (const m of milestones) expect(ids.has(m.nodeId), m.nodeId).toBe(true);
  });

  it("covers every enabled node, or exempts it with a reason", () => {
    const missing = graph.nodes
      .filter((n) => isNodeEnabled(n, graph.generators))
      .filter((n) => milestoneForNode(n.id) === undefined && !(n.id in MILESTONE_EXEMPT))
      .map((n) => n.id);
    expect(missing).toEqual([]);
  });

  it("exempts only real, uncovered nodes, each with a reason", () => {
    for (const [id, reason] of Object.entries(MILESTONE_EXEMPT)) {
      expect(
        graph.nodes.some((n) => n.id === id),
        id,
      ).toBe(true);
      expect(milestoneForNode(id), `${id} is both covered and exempt`).toBeUndefined();
      expect(reason.trim().length, id).toBeGreaterThan(0);
    }
  });

  it.each(milestones.map((m) => [m.nodeId, m.statement] as const))(
    "%s reads as one plain sentence",
    (_id, statement) => {
      expect(statement.length).toBeLessThanOrEqual(MAX_MILESTONE_CHARS);
      expect(statement).not.toMatch(/[—–“”‘’!]/);
      expect(statement).toMatch(/^You can [^.]+\.$/);
    },
  );
});

describe("parseMilestones", () => {
  it("names the failing entry and path", () => {
    expect(() => parseMilestones([{ nodeId: "x", statement: "" }])).toThrow(
      /index 0[\s\S]*statement/,
    );
  });
});
