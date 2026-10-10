import type { GeneratorInfo, SkillGraph, SkillNode } from "./schema.js";

export type GraphError =
  | { kind: "duplicateNodeId"; nodeId: string }
  | { kind: "duplicateGeneratorId"; generatorId: string }
  | { kind: "danglingPrerequisite"; nodeId: string; prerequisiteId: string; soft: boolean }
  | { kind: "unknownGenerator"; nodeId: string; generatorId: string }
  | { kind: "hardAndSoftPrerequisite"; nodeId: string; prerequisiteId: string }
  | { kind: "selfPrerequisite"; nodeId: string }
  | { kind: "cycle"; path: string[] };

export interface ValidationResult {
  ok: boolean;
  errors: GraphError[];
}

/** Human-readable one-line description of an error. */
export function describeGraphError(e: GraphError): string {
  switch (e.kind) {
    case "duplicateNodeId":
      return `duplicate node id "${e.nodeId}"`;
    case "duplicateGeneratorId":
      return `duplicate generator id "${e.generatorId}"`;
    case "danglingPrerequisite":
      return `node "${e.nodeId}" has unknown ${e.soft ? "soft " : ""}prerequisite "${e.prerequisiteId}"`;
    case "unknownGenerator":
      return `node "${e.nodeId}" uses generator "${e.generatorId}" missing from the generator list`;
    case "hardAndSoftPrerequisite":
      return `node "${e.nodeId}" lists "${e.prerequisiteId}" as both hard and soft prerequisite`;
    case "selfPrerequisite":
      return `node "${e.nodeId}" lists itself as a prerequisite`;
    case "cycle":
      return `prerequisite cycle: ${e.path.join(" -> ")}`;
  }
}

/**
 * Pure structural validation of a graph. Never throws. A soft prerequisite that
 * is also a hard ancestor is allowed and not reported.
 */
export function validateGraph(graph: SkillGraph): ValidationResult {
  const errors: GraphError[] = [];

  const nodeIds = new Set<string>();
  for (const n of graph.nodes) {
    if (nodeIds.has(n.id)) errors.push({ kind: "duplicateNodeId", nodeId: n.id });
    nodeIds.add(n.id);
  }

  const generatorIds = new Set<string>();
  for (const g of graph.generators) {
    if (generatorIds.has(g.id)) errors.push({ kind: "duplicateGeneratorId", generatorId: g.id });
    generatorIds.add(g.id);
  }

  for (const n of graph.nodes) {
    const hard = new Set(n.prerequisites);
    for (const p of n.prerequisites) {
      if (p === n.id) errors.push({ kind: "selfPrerequisite", nodeId: n.id });
      else if (!nodeIds.has(p))
        errors.push({ kind: "danglingPrerequisite", nodeId: n.id, prerequisiteId: p, soft: false });
    }
    for (const p of n.softPrerequisites ?? []) {
      if (hard.has(p))
        errors.push({ kind: "hardAndSoftPrerequisite", nodeId: n.id, prerequisiteId: p });
      if (p === n.id) errors.push({ kind: "selfPrerequisite", nodeId: n.id });
      else if (!nodeIds.has(p))
        errors.push({ kind: "danglingPrerequisite", nodeId: n.id, prerequisiteId: p, soft: true });
    }
    for (const g of n.itemGenerators) {
      if (!generatorIds.has(g))
        errors.push({ kind: "unknownGenerator", nodeId: n.id, generatorId: g });
    }
  }

  errors.push(...findCycles(graph.nodes, nodeIds));
  return { ok: errors.length === 0, errors };
}

/** DFS over hard + soft edges (node -> its prerequisites). Reports each back edge once. */
function findCycles(nodes: SkillNode[], nodeIds: Set<string>): GraphError[] {
  const edges = new Map<string, string[]>();
  for (const n of nodes) {
    const out = [...n.prerequisites, ...(n.softPrerequisites ?? [])].filter(
      (p) => p !== n.id && nodeIds.has(p),
    );
    edges.set(n.id, [...(edges.get(n.id) ?? []), ...out]);
  }

  const errors: GraphError[] = [];
  const state = new Map<string, 1 | 2>(); // 1 = on stack, 2 = done
  const stack: string[] = [];

  const visit = (id: string): void => {
    state.set(id, 1);
    stack.push(id);
    for (const next of edges.get(id) ?? []) {
      const s = state.get(next);
      if (s === 1) {
        errors.push({ kind: "cycle", path: [...stack.slice(stack.indexOf(next)), next] });
      } else if (s === undefined) {
        visit(next);
      }
    }
    stack.pop();
    state.set(id, 2);
  };

  for (const id of edges.keys()) if (!state.has(id)) visit(id);
  return errors;
}

/**
 * True if at least one of the node's generators is implemented. Nodes that are
 * not enabled must be treated as locked by the state engine and composer, no
 * matter what their prerequisites say.
 */
export function isNodeEnabled(
  node: Pick<SkillNode, "itemGenerators">,
  generators: readonly Pick<GeneratorInfo, "id" | "implemented">[],
): boolean {
  return node.itemGenerators.some((g) =>
    generators.some((info) => info.id === g && info.implemented),
  );
}
