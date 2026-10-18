import { cloneJson } from "./clone.js";
import type { Snapshot } from "../events/store.js";
import { REDUCER_VERSION } from "./reduce.js";
import type { LearnerState } from "./types.js";

export const LEARNER_SNAPSHOT_KEY = "learner";

/** Snapshot of a state. The state is deep-copied through JSON so later mutation cannot leak in. */
export function makeSnapshot(state: LearnerState, contentVersion: string): Snapshot {
  return {
    key: LEARNER_SNAPSHOT_KEY,
    reducerVersion: REDUCER_VERSION,
    contentVersion,
    lastEventAt: state.lastEvent?.at ?? 0,
    lastEventId: state.lastEvent?.id ?? "",
    state: JSON.parse(JSON.stringify(state)) as unknown,
  };
}

/** The snapshot's state, or undefined on key, reducer version or content version mismatch (R8). */
export function restoreSnapshot(
  snapshot: Snapshot,
  contentVersion: string,
): LearnerState | undefined {
  if (snapshot.key !== LEARNER_SNAPSHOT_KEY) return undefined;
  if (snapshot.reducerVersion !== REDUCER_VERSION) return undefined;
  if (snapshot.contentVersion !== contentVersion) return undefined;
  const s = snapshot.state;
  if (typeof s !== "object" || s === null) return undefined;
  const o = s as Partial<LearnerState>;
  if (
    typeof o.eventCount !== "number" ||
    typeof o.nodes !== "object" ||
    typeof o.pieces !== "object" ||
    typeof o.imported !== "object" ||
    typeof o.benchmarks !== "object" ||
    typeof o.tasks !== "object" ||
    typeof o.drills !== "object"
  ) {
    return undefined;
  }
  return cloneJson(s) as LearnerState;
}
