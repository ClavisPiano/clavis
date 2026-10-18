import type { LearnerState, TaskRecord } from "../state/types.js";
import { NODE_RANK } from "./key.js";

/*
 * Task priority (spec 5.4, R27, T5.8). A task is a HANDS or BYEAR node; Apply works on one of them
 * per session, the one with the highest `daysSince x (1 - rolling)`. Choices beyond the spec:
 *
 * - `daysSince` is fractional (milliseconds over a day) and never negative, so two tasks practised
 *   the same day still rank by how long ago and how well.
 * - A task never practised that is learning (or being introduced) has infinite priority, so its
 *   first items come before anything practised. One at fluent or beyond with no attempts (placed
 *   there, R19) counts as practised just now with a perfect score, so it waits until no other task
 *   has work. A node practised earlier today ranks by the same rule as any other: low, unless it
 *   went badly and nothing else is waiting.
 * - Ties (equal priority, for example two tasks never practised or two with a perfect score) go to
 *   the task practised longest ago, then to graph order.
 */

const MS_PER_DAY = 86_400_000;

/** Days since the task was practised times what is still to learn; Infinity when never practised. */
export function taskPriority(record: TaskRecord | undefined, now: number): number {
  if (record === undefined) return Infinity;
  const days = Math.max(0, now - record.lastPracticedAt) / MS_PER_DAY;
  const left = 1 - Math.min(1, Math.max(0, record.rolling));
  return days * left;
}

/**
 * The records task priority reads for `nodeIds`: the learner's own, and for a node at fluent or
 * beyond that has none (placed there), a perfect score practised `now`.
 */
export function taskRecords(
  nodeIds: readonly string[],
  state: Pick<LearnerState, "tasks" | "nodes">,
  now: number,
): Record<string, TaskRecord> {
  const out: Record<string, TaskRecord> = {};
  for (const id of nodeIds) {
    const own = state.tasks[id];
    if (own !== undefined) out[id] = own;
    else if (NODE_RANK[state.nodes[id]?.state ?? "locked"] >= NODE_RANK.fluent) {
      out[id] = { lastPracticedAt: now, rolling: 1 };
    }
  }
  return out;
}

/**
 * The task to work on: the highest `taskPriority` among `nodeIds` (in graph order), ties to the
 * one practised longest ago, then graph order. Undefined when there is none.
 */
export function pickTask(
  nodeIds: readonly string[],
  tasks: Readonly<Record<string, TaskRecord>>,
  now: number,
): string | undefined {
  let best: { id: string; priority: number; last: number } | undefined;
  for (const id of nodeIds) {
    const rec = tasks[id];
    const priority = taskPriority(rec, now);
    const last = rec?.lastPracticedAt ?? -Infinity;
    if (
      best === undefined ||
      priority > best.priority ||
      (priority === best.priority && last < best.last)
    ) {
      best = { id, priority, last };
    }
  }
  return best?.id;
}
