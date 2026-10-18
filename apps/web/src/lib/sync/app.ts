import { observeServerDate, wallNow } from "../clock";
import { metaCursorStore, syncOnce, type SyncResult } from "@clavis/core";
import { uploadPendingBlobs } from "../blobs/app";
import { getLearnerState } from "../learner";
import { createSyncController, type SyncController } from "./controller";
import { isSignedInHint, setSessionExpired, setSignedInHint } from "./hint";
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
        transport: createFetchTransport(undefined, undefined, (date) => {
          observeServerDate(date);
        }),
        cursorStore: metaCursorStore(r.store),
        onOversized: (event) => {
          console.warn(`Event ${event.id} (${event.type}) is too large to sync and was skipped`);
        },
        onRejected: (batch, error) => {
          console.error(`Sync batch of ${String(batch.length)} events was rejected`, error, batch);
        },
      });
    },
    afterSync: uploadPendingBlobs,
    now: () => wallNow(),
    isVisible: () => document.visibilityState === "visible",
    isOnline: () => navigator.onLine,
    doc: document,
    win: window,
    isSignedIn: isSignedInHint,
    onSignedOut: () => {
      setSessionExpired(true);
      setSignedInHint(false);
    },
  });
  return controller;
}
