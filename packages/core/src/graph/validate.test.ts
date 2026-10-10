import { describe, expect, it } from "vitest";
import {
  isNodeEnabled,
  SkillGraphSchema,
  validateGraph,
  type GeneratorId,
  type GeneratorInfo,
  type SkillGraph,
  type SkillNode,
} from "./index.js";

function node(id: string, over: Partial<SkillNode> = {}): SkillNode {
  return {
    id,
    strand: "EAR",
    title: id,
    prerequisites: [],
    itemGenerators: ["degreeId"],
    params: {},
    mastery: { minAccuracy: 0.9, windowAttempts: 20, distinctSessions: 2 },
    keyDependent: false,
    ...over,
  };
}

function gen(id: GeneratorId, implemented = false): GeneratorInfo {
  return { id, implemented, seedDurationSec: 8, awayEligible: true, requires: ["keys"] };
}

function graph(nodes: SkillNode[], generators = [gen("degreeId"), gen("cellEcho")]): SkillGraph {
  return { contentVersion: "test", nodes, generators };
}

describe("validateGraph", () => {
  it("accepts a valid graph", () => {
    const g = graph([node("a"), node("b", { prerequisites: ["a"] })]);
    expect(validateGraph(g)).toEqual({ ok: true, errors: [] });
  });

  it("reports duplicate node ids", () => {
    const r = validateGraph(graph([node("a"), node("a")]));
    expect(r.ok).toBe(false);
    expect(r.errors).toContainEqual({ kind: "duplicateNodeId", nodeId: "a" });
  });

  it("reports dangling hard prerequisites", () => {
    const r = validateGraph(graph([node("a", { prerequisites: ["zz"] })]));
    expect(r.errors).toEqual([
      { kind: "danglingPrerequisite", nodeId: "a", prerequisiteId: "zz", soft: false },
    ]);
  });

  it("reports dangling soft prerequisites", () => {
    const r = validateGraph(graph([node("a", { softPrerequisites: ["zz"] })]));
    expect(r.errors).toEqual([
      { kind: "danglingPrerequisite", nodeId: "a", prerequisiteId: "zz", soft: true },
    ]);
  });

  it("reports a cycle with its path", () => {
    const r = validateGraph(
      graph([
        node("a", { prerequisites: ["c"] }),
        node("b", { prerequisites: ["a"] }),
        node("c", { prerequisites: ["b"] }),
      ]),
    );
    const cycles = r.errors.filter((e) => e.kind === "cycle");
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toEqual({ kind: "cycle", path: ["a", "c", "b", "a"] });
  });

  it("counts soft edges when detecting cycles", () => {
    const r = validateGraph(
      graph([node("a", { softPrerequisites: ["b"] }), node("b", { prerequisites: ["a"] })]),
    );
    expect(r.errors.some((e) => e.kind === "cycle")).toBe(true);
  });

  it("reports unknown generators", () => {
    const r = validateGraph(graph([node("a", { itemGenerators: ["degreeId", "bassMotion"] })]));
    expect(r.errors).toEqual([
      { kind: "unknownGenerator", nodeId: "a", generatorId: "bassMotion" },
    ]);
  });

  it("reports a prerequisite listed as both hard and soft", () => {
    const r = validateGraph(
      graph([node("a"), node("b", { prerequisites: ["a"], softPrerequisites: ["a"] })]),
    );
    expect(r.errors).toEqual([
      { kind: "hardAndSoftPrerequisite", nodeId: "b", prerequisiteId: "a" },
    ]);
  });

  it("does not flag a soft prerequisite that is also a hard ancestor", () => {
    const r = validateGraph(
      graph([
        node("a"),
        node("b", { prerequisites: ["a"] }),
        node("c", { prerequisites: ["b"], softPrerequisites: ["a"] }),
      ]),
    );
    expect(r.ok).toBe(true);
  });

  it("reports duplicate generators and self prerequisites", () => {
    const r = validateGraph(
      graph([node("a", { prerequisites: ["a"] })], [gen("degreeId"), gen("degreeId")]),
    );
    expect(r.errors).toContainEqual({ kind: "duplicateGeneratorId", generatorId: "degreeId" });
    expect(r.errors).toContainEqual({ kind: "selfPrerequisite", nodeId: "a" });
  });
});

describe("isNodeEnabled", () => {
  it("is true when at least one generator is implemented", () => {
    const gens = [gen("degreeSing", false), gen("degreeId", true)];
    expect(isNodeEnabled({ itemGenerators: ["degreeSing", "degreeId"] }, gens)).toBe(true);
  });

  it("is false when none are implemented or listed", () => {
    const gens = [gen("degreeSing", false)];
    expect(isNodeEnabled({ itemGenerators: ["degreeSing"] }, gens)).toBe(false);
    expect(isNodeEnabled({ itemGenerators: ["cellEcho"] }, gens)).toBe(false);
  });
});

describe("SkillGraphSchema", () => {
  it("rejects an empty generator list and out-of-range mastery", () => {
    const bad = graph([node("a", { itemGenerators: [] })]);
    expect(SkillGraphSchema.safeParse(bad).success).toBe(false);
    const bad2 = graph([
      node("a", { mastery: { minAccuracy: 1.5, windowAttempts: 0, distinctSessions: 1 } }),
    ]);
    expect(SkillGraphSchema.safeParse(bad2).success).toBe(false);
  });
});
