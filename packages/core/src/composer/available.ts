import { composeSession } from "./compose.js";
import type { ComposeInput } from "./types.js";

/**
 * True when "Learn something new" would give the learner at least one new item now: a node that
 * can be introduced, or fresh items in learning nodes or open key families. It composes the same
 * plan that the Learn session would, so Home and the summary agree with the session itself.
 * `batch` is one extra batch of new items (the `newItemsPerDay` setting).
 */
export function hasNewMaterial(
  input: Omit<ComposeInput, "practice" | "extraNewItems" | "seed"> & { batch: number },
): boolean {
  const { batch, ...rest } = input;
  const plan = composeSession({ ...rest, seed: 0, extraNewItems: batch });
  return [...plan.blocks.ear, ...plan.blocks.read].some((i) => i.isNew);
}
