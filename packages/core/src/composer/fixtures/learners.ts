import type { LearningEvent } from "../../events/schema.js";
import { itemId } from "../../items/ids.js";
import { createScheduler } from "../../scheduler/scheduler.js";
import { foldEvents } from "../../state/reduce.js";
import { Builder, DAY_MS } from "../../state/test-helpers.js";
import type { LearnerState } from "../../state/types.js";
import { V1_GRAPH } from "./graph.js";

/* Test-only learner fixtures, built by folding realistic events with the real reducer. */

export const CTX = { graph: V1_GRAPH, scheduler: createScheduler() };

/** 2026-03-10T10:00:00Z, a Tuesday, mid learner day for tz 0. */
export const NOW = Date.UTC(2026, 2, 10, 10, 0, 0);

const degreeItem = (nodeId: string, degree: number): string => itemId(nodeId, { degree });

export const D135 = "ear.degrees.major.135";
export const DIATONIC = "ear.degrees.major.diatonic";

export function fold(events: LearningEvent[]): LearnerState {
  return foldEvents(events, CTX);
}

/** A learner who has never opened the app. */
export function newLearner(): LearnerState {
  return fold([]);
}

interface Drill {
  nodeId: string;
  degrees: number[];
  introduce?: boolean;
  isNew?: boolean;
}

/** One finished instrument session `daysAgo` days before NOW, with realistic 5 s items. */
function session(b: Builder, n: number, daysAgo: number, drills: Drill[]): LearningEvent[] {
  const at = NOW - daysAgo * DAY_MS;
  const sid = b.sessionId(n);
  const out: LearningEvent[] = [b.start(at, sid, { budgetSec: 720 })];
  let t = at + 1000;
  for (const d of drills) {
    if (d.introduce) {
      out.push(b.introduce(t, sid, d.nodeId));
      t += 1000;
    }
    for (const degree of d.degrees) {
      out.push(
        ...b.item(t, sid, d.nodeId, degreeItem(d.nodeId, degree), {
          latencyMs: 5000,
          isNew: d.isNew ?? false,
        }),
      );
      t += 8000;
    }
  }
  out.push(b.end(t, sid));
  return out;
}

/**
 * 135 mastered by placement. Diatonic degrees introduced four days ago with items 1 to 3; the
 * 135 cards are older. Everything reviewed is due by NOW, diatonic degrees 4 to 7 are still new.
 */
export function learnerWithDueCards(): LearnerState {
  const b = new Builder();
  return fold([
    b.place(NOW - 10 * DAY_MS, { [D135]: "mastered" }),
    ...session(b, 1, 6, [{ nodeId: D135, degrees: [1, 3, 5, 1, 3, 5] }]),
    ...session(b, 2, 4, [
      { nodeId: DIATONIC, degrees: [1, 2, 3], introduce: true, isNew: true },
      { nodeId: D135, degrees: [1, 3, 5] },
    ]),
  ]);
}

/** Same learner, but five new items were already presented earlier today. */
export function learnerAtDailyCap(): LearnerState {
  const b = new Builder();
  const earlier = NOW - 3 * 3_600_000;
  const sid = b.sessionId(9);
  const events: LearningEvent[] = [
    b.place(NOW - 10 * DAY_MS, { [D135]: "mastered" }),
    ...session(b, 1, 6, [{ nodeId: D135, degrees: [1, 3, 5, 1, 3, 5] }]),
    b.start(earlier, sid),
    b.introduce(earlier + 1000, sid, DIATONIC),
  ];
  let t = earlier + 2000;
  for (const degree of [1, 2, 3, 4, 5]) {
    events.push(
      ...b.item(t, sid, DIATONIC, degreeItem(DIATONIC, degree), { latencyMs: 5000, isNew: true }),
    );
    t += 8000;
  }
  events.push(b.end(t, sid));
  return fold(events);
}
