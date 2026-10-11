import {
  createScheduler,
  LearnerStateService,
  type EventStore,
  type Scheduler,
  type SkillGraph,
} from "@clavis/core";
import { loadGraph } from "@clavis/content";
import { initAppStore, type AppStoreResult } from "./app-store";

/*
 * App-level learner state wiring (T2.11). One `LearnerStateService` per app, built over the app's
 * event store and memoized like the store itself.
 *
 * For callers (the session runner):
 *   const r = await getLearnerState();
 *   if (!r.ok) { ...storage unavailable, show a notice... }
 *   r.service.state            // current LearnerState (already loaded)
 *   await r.service.append(ev) // append events and refold; returns the new state
 *   r.graph / r.scheduler      // the same graph and scheduler the service folds with
 * In Svelte components prefer `useLearner()` from `./learner.svelte`, which exposes the state
 * reactively and refreshes after appends made through it.
 */

export type LearnerResult =
  | {
      readonly ok: true;
      readonly service: LearnerStateService;
      readonly store: EventStore;
      readonly deviceId: string;
      readonly graph: SkillGraph;
      readonly scheduler: Scheduler;
    }
  | { readonly ok: false; readonly error: unknown };

export interface LearnerDeps {
  initStore: () => Promise<AppStoreResult>;
  graph: SkillGraph;
  scheduler: Scheduler;
}

/** Memoized: the service is built and loaded once; every caller gets the same promise. Never rejects. */
export function createLearnerInitializer(deps: LearnerDeps): () => Promise<LearnerResult> {
  let pending: Promise<LearnerResult> | undefined;
  return () => {
    pending ??= (async (): Promise<LearnerResult> => {
      const base = await deps.initStore();
      if (!base.ok) return base;
      try {
        const service = new LearnerStateService({
          store: base.store,
          ctx: { graph: deps.graph, scheduler: deps.scheduler },
        });
        await service.load();
        return {
          ok: true,
          service,
          store: base.store,
          deviceId: base.deviceId,
          graph: deps.graph,
          scheduler: deps.scheduler,
        };
      } catch (error) {
        console.error("Could not load learner state", error);
        return { ok: false, error };
      }
    })();
    return pending;
  };
}

let singleton: (() => Promise<LearnerResult>) | undefined;

/** Client-only. Lazily creates the one app-wide `LearnerStateService`. */
export function getLearnerState(): Promise<LearnerResult> {
  singleton ??= createLearnerInitializer({
    initStore: initAppStore,
    graph: loadGraph(),
    scheduler: createScheduler(),
  });
  return singleton();
}
