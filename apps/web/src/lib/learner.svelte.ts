import type { LearnerState, LearningEvent } from "@clavis/core";
import { getLearnerState, type LearnerResult } from "./learner";
import { createPractisedReporter } from "./practice-cue-browser";

type Ready = Extract<LearnerResult, { ok: true }>;

/**
 * Svelte-friendly wrapper around the app's `LearnerStateService`. `state` is reactive and is
 * replaced after every `append` or `refresh`. Call `init()` from `onMount`.
 */
export class ReactiveLearner {
  state = $state.raw<LearnerState | undefined>(undefined);
  status = $state<"loading" | "ready" | "failed">("loading");
  private result: Ready | undefined;
  /** Tells the Worker once a day that today was practised, so the practice cue is skipped. */
  private reportPractised: ((state: LearnerState) => void) | undefined;

  get ctx(): Ready {
    if (!this.result) throw new Error("ReactiveLearner.init() has not completed");
    return this.result;
  }

  async init(): Promise<void> {
    const r = await getLearnerState();
    if (!r.ok) {
      this.status = "failed";
      return;
    }
    this.result = r;
    this.state = r.service.state;
    this.status = "ready";
    this.reportPractised = createPractisedReporter(r.store);
    this.reportPractised(r.service.state);
  }

  async append(events: LearningEvent[]): Promise<LearnerState> {
    this.state = await this.ctx.service.append(events);
    this.reportPractised?.(this.state);
    return this.state;
  }

  /** Re-read the service state after something else changed it (for example an import). */
  refresh(): void {
    this.state = this.ctx.service.state;
  }
}

export function useLearner(): ReactiveLearner {
  return new ReactiveLearner();
}
