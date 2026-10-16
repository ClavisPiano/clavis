import type { SyncState } from "../sync/controller";

/** One line for the Settings sync status. `locale` is injectable for tests. */
export function syncStatusText(state: SyncState, locale?: string): string {
  const last =
    state.lastSyncedAt === undefined
      ? ""
      : ` Last synced ${new Date(state.lastSyncedAt).toLocaleString(locale, {
          dateStyle: "medium",
          timeStyle: "short",
        })}.`;
  switch (state.status) {
    case "syncing":
      return `Syncing...${last}`;
    case "offline":
      return `Offline. Your practice is saved on this device and will sync when you are back online.${last}`;
    case "signedOut":
      return `Not syncing because you are signed out.${last}`;
    case "error":
      return `Sync hit a problem and will try again.${last}`;
    case "idle":
      return state.lastSyncedAt === undefined ? "Waiting to sync." : `Synced.${last}`;
  }
}

/** The text of the recovery codes download and clipboard copy. */
export function recoveryCodesText(codes: readonly string[]): string {
  return [
    "Clavis recovery codes",
    "",
    "Each code works once. Use one on the sign in screen if you lose access to your passkeys.",
    "Keep these somewhere safe and private.",
    "",
    ...codes,
    "",
  ].join("\n");
}

export const RECOVERY_CODES_FILENAME = "clavis-recovery-codes.txt";
