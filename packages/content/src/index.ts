import {
  ConceptCardSchema,
  SkillGraphSchema,
  type ConceptCard,
  type SkillGraph,
} from "@clavis/core";
import { CARDS_V1, ORIENT_CARD_ID } from "./cards/v1.js";

export { conceptTip, type ConceptTip, type TipMode } from "./tips.js";
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

export { ORIENT_CARD_ID };

/** Parse raw card documents. Throws with the card index and path on schema failure. */
export function parseCards(raw: readonly unknown[]): ConceptCard[] {
  return raw.map((doc, i) => {
    const result = ConceptCardSchema.safeParse(doc);
    if (!result.success) {
      const lines = result.error.issues.map(
        (x) => `  ${x.path.join(".") || "(root)"}: ${x.message}`,
      );
      throw new Error(`Invalid concept card at index ${String(i)}:\n${lines.join("\n")}`);
    }
    return result.data;
  });
}

let cards: ConceptCard[] | undefined;

/** All v1 concept cards (spec 13). */
export function loadCards(): readonly ConceptCard[] {
  cards ??= parseCards(CARDS_V1);
  return cards;
}

export function cardById(id: string): ConceptCard | undefined {
  return loadCards().find((c) => c.id === id);
}

/** The card that explains `nodeId`, if one is written. */
export function cardForNode(nodeId: string): ConceptCard | undefined {
  return loadCards().find((c) => c.nodeIds.includes(nodeId));
}
