import { metaCursorStore, syncOnce, type SyncResult } from "@clavis/core";
import { getLearnerState } from "../learner";
import { createSyncController, type SyncController } from "./controller";
import { isSignedInHint, setSignedInHint } from "./hint";
import { createFetchTransport } from "./transport";

let controller: SyncController | undefined;

/** Client-only app-wide sync controller. Call `start()` once (the root layout does). */
export function getSyncController(): SyncController {
  controller ??= createSyncController({
    run: async (): Promise<SyncResult> => {
      const r = await getLearnerState();
      if (!r.ok) {
        return {
          outcome: "error",
          pushed: 0,
          pulledNew: 0,
          skipped: 0,
          detail: "storage unavailable",
        };
      }
      return syncOnce({
        store: r.store,
        learner: r.service,
        transport: createFetchTransport(),
        cursorStore: metaCursorStore(r.store),
        onRejected: (batch, error) => {
          console.error(`Sync batch of ${String(batch.length)} events was rejected`, error, batch);
        },
      });
    },
    now: () => Date.now(),
    isVisible: () => document.visibilityState === "visible",
    isOnline: () => navigator.onLine,
    doc: document,
    win: window,
    isSignedIn: isSignedInHint,
    onSignedOut: () => {
      setSignedInHint(false);
    },
  });
  return controller;
}
