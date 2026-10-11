import type { LearningEvent } from "../events/schema.js";
import type { EventStore } from "../events/store.js";
import { compareEvents } from "../events/validate.js";
import { foldEvents, foldOnto } from "./reduce.js";
import { LEARNER_SNAPSHOT_KEY, makeSnapshot, restoreSnapshot } from "./snapshot.js";
import type { FoldContext, LearnerState } from "./types.js";

export const DEFAULT_SNAPSHOT_EVERY = 200;

export interface LearnerStateServiceOptions {
  store: EventStore;
  ctx: FoldContext;
  /** Write a snapshot after this many events since the last one. Default 200. */
  snapshotEvery?: number;
}

/**
 * Keeps a `LearnerState` in step with an `EventStore`. Events appended in
 * (at, id) order apply incrementally; anything that sorts at or before the
 * current head (a sync merge, clock skew) refolds from scratch.
 *
 * Events written to the store behind the service's back are not seen until
 * `load()` runs again, and a late event older than a stored snapshot is only
 * picked up if snapshots are cleared, so route merges through `append`.
 */
export class LearnerStateService {
  private readonly store: EventStore;
  private readonly ctx: FoldContext;
  private readonly snapshotEvery: number;
  private current: LearnerState | undefined;
  private lastSnapshotCount = 0;

  constructor(opts: LearnerStateServiceOptions) {
    this.store = opts.store;
    this.ctx = opts.ctx;
    this.snapshotEvery = opts.snapshotEvery ?? DEFAULT_SNAPSHOT_EVERY;
  }

  /** Current state. Throws before `load()`. */
  get state(): LearnerState {
    if (!this.current) throw new Error("LearnerStateService.load() has not been called");
    return this.current;
  }

  async load(): Promise<LearnerState> {
    const snap = await this.store.getSnapshot(LEARNER_SNAPSHOT_KEY);
    const restored = snap ? restoreSnapshot(snap, this.ctx.graph.contentVersion) : undefined;
    let state: LearnerState | undefined;
    if (restored?.lastEvent) {
      try {
        const tail = await this.store.list({ afterId: restored.lastEvent.id });
        state = foldOnto(restored, tail, this.ctx);
        this.lastSnapshotCount = restored.eventCount;
      } catch {
        state = undefined; // cursor event unknown to the store: fall back to a full fold
      }
    }
    if (!state) {
      this.lastSnapshotCount = 0;
      state = foldEvents(await this.store.list(), this.ctx);
    }
    this.current = state;
    await this.maybeSnapshot();
    return state;
  }

  async append(events: LearningEvent[]): Promise<LearnerState> {
    const before = this.state;
    const { inserted } = await this.store.append(events);
    if (inserted === 0) return before;
    const head = before.lastEvent;
    const sorted = [...new Map(events.map((e) => [e.id, e])).values()].sort(compareEvents);
    const first = sorted[0];
    const inOrder = first !== undefined && (head === undefined || compareEvents(first, head) > 0);
    if (inOrder) {
      this.current = foldOnto(before, sorted, this.ctx);
    } else {
      this.current = foldEvents(await this.store.list(), this.ctx);
      this.lastSnapshotCount = 0;
    }
    await this.maybeSnapshot();
    return this.current;
  }

  private async maybeSnapshot(): Promise<void> {
    const state = this.state;
    if (state.eventCount - this.lastSnapshotCount < this.snapshotEvery) return;
    await this.store.putSnapshot(makeSnapshot(state, this.ctx.graph.contentVersion));
    this.lastSnapshotCount = state.eventCount;
  }
}
