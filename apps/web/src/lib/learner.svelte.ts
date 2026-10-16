import type { LearnerState, LearningEvent } from "@clavis/core";
import { getLearnerState, type LearnerResult } from "./learner";
import { getSyncController } from "./sync/app";

type Ready = Extract<LearnerResult, { ok: true }>;

/**
 * Svelte-friendly wrapper around the app's `LearnerStateService`. `state` is reactive and is
 * replaced after every `append` or `refresh`. Call `init()` from `onMount`.
 */
export class ReactiveLearner {
  state = $state.raw<LearnerState | undefined>(undefined);
  status = $state<"loading" | "ready" | "failed">("loading");
  private result: Ready | undefined;

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
    // Sync merges other devices' events behind our back: pick up the refolded state. The weak
    // reference lets pages that were left behind be collected; their listener then removes itself.
    const ref = new WeakRef(this);
    const off = getSyncController().onPulled(() => {
      const self = ref.deref();
      if (self) self.refresh();
      else off();
    });
  }

  async append(events: LearningEvent[]): Promise<LearnerState> {
    this.state = await this.ctx.service.append(events);
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
