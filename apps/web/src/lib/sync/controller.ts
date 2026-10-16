import type { SyncResult } from "@clavis/core";

/*
 * Sync triggers and status (T4.3). Plain TypeScript with injected environment so it is testable
 * with fake timers; `app.ts` wires the real browser and `status.svelte.ts` makes it reactive.
 *
 * - Single-flight: a trigger during a run schedules exactly one follow-up run, never a parallel one.
 * - Signed out (401): remembered. Only explicit triggers (start, session end, visible, online)
 *   retry, which costs one cheap 401. The 5 minute timer stays quiet while signed out.
 * - The timer runs only while the page is visible and online.
 */

export type SyncStatus = "idle" | "syncing" | "offline" | "signedOut" | "error";
export type SyncReason = "start" | "manual" | "sessionEnd" | "visible" | "online" | "timer";

export interface SyncState {
  status: SyncStatus;
  /** Epoch ms of the last run that finished `ok`. */
  lastSyncedAt?: number;
  detail?: string;
}

export const SYNC_INTERVAL_MS = 5 * 60_000;

interface Target {
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

export interface SyncControllerDeps {
  run: () => Promise<SyncResult>;
  now: () => number;
  isVisible: () => boolean;
  isOnline: () => boolean;
  doc: Target;
  win: Target;
  intervalMs?: number;
}

export interface SyncController {
  readonly state: SyncState;
  trigger(reason: SyncReason): Promise<void>;
  start(): () => void;
  subscribe(fn: (s: SyncState) => void): () => void;
  /** Called after a run that added events from other devices. */
  onPulled(fn: () => void): () => void;
  /** The user just signed in or up (T4.4): forget `signedOut` and sync immediately. */
  notifySignedIn(): Promise<void>;
  /** The user signed out (T4.4): stop timer syncs and show `signedOut`. Local data is kept. */
  notifySignedOut(): void;
}

export function createSyncController(deps: SyncControllerDeps): SyncController {
  let state: SyncState = { status: "idle" };
  let running: Promise<void> | undefined;
  let rerun = false;
  let signedOut = false;
  const subs = new Set<(s: SyncState) => void>();
  const pulledSubs = new Set<() => void>();

  const set = (next: SyncState): void => {
    state = next;
    for (const fn of [...subs]) fn(state);
  };

  async function runOnce(): Promise<void> {
    set({ ...state, status: "syncing" });
    let result: SyncResult;
    try {
      result = await deps.run();
    } catch (e) {
      result = {
        outcome: "error",
        pushed: 0,
        pulledNew: 0,
        skipped: 0,
        detail: e instanceof Error ? e.message : String(e),
      };
    }
    signedOut = result.outcome === "signedOut";
    const kept = state.lastSyncedAt === undefined ? {} : { lastSyncedAt: state.lastSyncedAt };
    if (result.outcome === "ok") set({ status: "idle", lastSyncedAt: deps.now() });
    else {
      const detail = result.detail === undefined ? {} : { detail: result.detail };
      set({ status: result.outcome, ...kept, ...detail });
    }
    if (result.pulledNew > 0) for (const fn of [...pulledSubs]) fn();
  }

  function trigger(reason: SyncReason): Promise<void> {
    if (reason === "timer" && (signedOut || !deps.isVisible() || !deps.isOnline())) {
      return running ?? Promise.resolve();
    }
    if (running) {
      rerun = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          rerun = false;
          await runOnce();
        } while (rerun as boolean);
      } finally {
        running = undefined;
      }
    })();
    return running;
  }

  return {
    get state() {
      return state;
    },
    trigger,
    start() {
      const onVisibility = (): void => {
        if (deps.isVisible()) void trigger("visible");
      };
      const onOnline = (): void => {
        void trigger("online");
      };
      deps.doc.addEventListener("visibilitychange", onVisibility);
      deps.win.addEventListener("online", onOnline);
      const timer = setInterval(() => void trigger("timer"), deps.intervalMs ?? SYNC_INTERVAL_MS);
      void trigger("start");
      return () => {
        deps.doc.removeEventListener("visibilitychange", onVisibility);
        deps.win.removeEventListener("online", onOnline);
        clearInterval(timer);
      };
    },
    subscribe(fn) {
      subs.add(fn);
      fn(state);
      return () => subs.delete(fn);
    },
    notifySignedIn() {
      signedOut = false;
      return trigger("start");
    },
    notifySignedOut() {
      signedOut = true;
      const kept = state.lastSyncedAt === undefined ? {} : { lastSyncedAt: state.lastSyncedAt };
      set({ status: "signedOut", ...kept });
    },
    onPulled(fn) {
      pulledSubs.add(fn);
      return () => pulledSubs.delete(fn);
    },
  };
}
