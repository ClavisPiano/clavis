import { hasNewMaterial, type LearnerState, type SessionMode, type SkillGraph } from "@clavis/core";
import { effectiveSettings, hasStartedItems } from "./home";
import { MAX_BUDGET_SEC, MIN_BUDGET_SEC } from "./session/params";

/*
 * What to offer once a session is over (and on Home once today's session is done): keep going with
 * extra practice, learn something new, or stop. Pure, so Home and the session summary agree.
 */

/** Less time than this left in the budget counts as used up: Keep going then offers a full round. */
export const MIN_REMAINING_SEC = 60;
const STEP_SEC = 30;

/** Length of a Keep going round: what is left of the budget, or a whole budget when it is used up. */
export function keepGoingBudgetSec(budgetSec: number, elapsedSec: number): number {
  const remaining = budgetSec - elapsedSec;
  const sec =
    remaining >= MIN_REMAINING_SEC ? Math.round(remaining / STEP_SEC) * STEP_SEC : budgetSec;
  return Math.min(MAX_BUDGET_SEC, Math.max(MIN_BUDGET_SEC, Math.round(sec)));
}

export interface NextSteps {
  /** Extra practice: needs at least one started item. */
  keepGoing: boolean;
  /** Seconds for the Keep going round. */
  keepGoingSec: number;
  /** "Learn something new": a node could be introduced or fresh items are waiting. */
  learn: boolean;
}

export function nextSteps(opts: {
  state: LearnerState;
  graph: SkillGraph;
  now: number;
  tzOffsetMin: number;
  mode: SessionMode;
  /** The session's budget in seconds. */
  budgetSec: number;
  /** Seconds used in the session just finished; 0 on Home. */
  elapsedSec: number;
}): NextSteps {
  const batch = effectiveSettings(opts.state.settings).newItemsPerDay;
  return {
    keepGoing: hasStartedItems(opts.state),
    keepGoingSec: keepGoingBudgetSec(opts.budgetSec, opts.elapsedSec),
    learn: hasNewMaterial({
      state: opts.state,
      graph: opts.graph,
      now: opts.now,
      tzOffsetMin: opts.tzOffsetMin,
      mode: opts.mode,
      batch,
      budgetSec: opts.budgetSec,
    }),
  };
}

/**
 * Query string for a follow-up session, keeping the other params (input, audio, mode) of the
 * current one. Keep going sets its own budget; Learn keeps the current budget unless the current
 * session was a practice round, whose budget was sized for practice.
 */
export function followUpSearch(
  current: { toString(): string; get(name: string): string | null },
  kind: "practice" | "learn",
  budgetSec?: number,
): string {
  const q = new URLSearchParams(current.toString());
  const wasPractice = q.get("practice") === "1";
  q.delete("practice");
  q.delete("learn");
  if (budgetSec !== undefined) q.set("budget", String(budgetSec));
  else if (wasPractice) q.delete("budget");
  q.set(kind, "1");
  return `?${q.toString()}`;
}
