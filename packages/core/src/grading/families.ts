import type { NodeState } from "../graph/schema.js";
import type { KeyFamily } from "../theory/keys.js";

const RANK: Record<NodeState, number> = {
  locked: 0,
  available: 1,
  learning: 2,
  fluent: 3,
  mastered: 4,
};

/**
 * Combine per-family states of a key-dependent node into one global state (spec 3.4).
 *
 * - `mastered` when family A is mastered and family B is at least fluent.
 * - Otherwise the state of family A, capped at `fluent` (A mastered without B
 *   fluent is not globally mastered), but raised to `learning` if any family
 *   (including C) is learning or beyond.
 * - A missing family A counts as `available`; with no families at all the
 *   result is `available`.
 *
 * Family C never raises the state beyond `learning`; it feeds review only.
 */
export function combineFamilyStates(byFamily: Partial<Record<KeyFamily, NodeState>>): NodeState {
  const a = byFamily.A;
  const b = byFamily.B;
  if (a === "mastered" && b !== undefined && RANK[b] >= RANK.fluent) return "mastered";
  let result: NodeState = a ?? "available";
  if (result === "mastered") result = "fluent";
  const anyActive = Object.values(byFamily).some((s) => RANK[s] >= RANK.learning);
  if (anyActive && RANK[result] < RANK.learning) result = "learning";
  return result;
}
