import type { SyncState } from "./controller";
import { getSyncController } from "./app";

/** Reactive view of the sync status for UI (T4.4). Client-only; call `init()` from `onMount`. */
export class ReactiveSyncStatus {
  state = $state.raw<SyncState>({ status: "idle" });
  private off: (() => void) | undefined;

  init(): void {
    this.off?.();
    this.off = getSyncController().subscribe((s) => {
      this.state = s;
    });
  }

  destroy(): void {
    this.off?.();
    this.off = undefined;
  }

  syncNow(): Promise<void> {
    return getSyncController().trigger("start");
  }
}
