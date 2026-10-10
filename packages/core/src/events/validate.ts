import { parseEvent, type LearningEvent } from "./schema.js";
import { InvalidEventError } from "./store.js";

/** Validate a whole batch, throwing `InvalidEventError` on the first bad event. */
export function validateBatch(events: readonly unknown[]): LearningEvent[] {
  return events.map((event, index) => {
    const result = parseEvent(event);
    if (!result.ok) throw new InvalidEventError(index, result.error.message);
    return result.event;
  });
}

/** Total order used by every store: by `at`, then `id`. */
export function compareEvents(
  a: { at: number; id: string },
  b: { at: number; id: string },
): number {
  if (a.at !== b.at) return a.at - b.at;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
