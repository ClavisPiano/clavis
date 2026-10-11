import { SkillGraphSchema, type SkillGraph } from "@clavis/core";
import v1 from "./graph/v1.json";

export const PACKAGE_NAME = "@clavis/content";

/**
 * Parse and schema-validate a raw graph document. Throws an Error with a
 * readable, path-annotated message on schema failure. Structural checks
 * (cycles, dangling ids) are the job of `validateGraph` in core.
 */
export function parseGraph(raw: unknown): SkillGraph {
  const result = SkillGraphSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`Invalid skill graph content:\n${lines.join("\n")}`);
  }
  return result.data;
}

/**
 * Load the v1 skill graph from `graph/v1.json` (see `graph/NOTES.md` for the
 * rationale behind params, mastery and latency choices).
 *
 * `contentVersion` inside the JSON MUST change whenever graph semantics change
 * (nodes, prerequisites, params, mastery criteria, generators). Derived-state
 * snapshots are keyed by it (R8), so a stale version would silently reuse
 * snapshots computed against a different graph.
 *
 * The four ear generators (degreeSing, degreeId, cellEcho, rhythmEcho) are implemented in
 * core/items (T2.6); the rest ship with `implemented: false`.
 */
export function loadGraph(): SkillGraph {
  return parseGraph(v1);
}
