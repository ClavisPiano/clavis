import { PERSIST_KEY, type KeyValueStoreLike } from "./pwa/persist";
import { wallNow } from "./clock";

/*
 * T8.1: a nudge to back up, for learners whose practice lives only in this browser. IndexedDB can
 * be evicted (notably on iOS) unless the browser grants persistent storage, and without an account
 * there is no copy anywhere else. Pure decision here; the Home page reads and writes the three
 * localStorage values and shows the card.
 */

export const LAST_BACKUP_KEY = "clavis.last-backup";
export const NUDGE_DISMISSED_KEY = "clavis.backup-nudge-dismissed";

const DAY_MS = 86_400_000;
/** A backup older than this counts as stale. */
export const BACKUP_STALE_DAYS = 14;
/** "Not now" hides the card for this long. */
export const NUDGE_SNOOZE_DAYS = 7;
/** Below this many events there is little to lose, so no nudge. */
export const NUDGE_MIN_EVENTS = 30;

export type PersistState = "granted" | "denied" | "unknown";

export interface NudgeInput {
  now: number;
  signedIn: boolean;
  persist: PersistState;
  eventCount: number;
  /** Epoch ms of the last backup file saved from this device, if any. */
  lastBackupAt: number | undefined;
  /** Epoch ms of the last "Not now", if any. */
  dismissedAt: number | undefined;
}

/**
 * True when the card should show: nothing is syncing to an account, the browser has not promised to
 * keep the data, there is enough to lose, the last backup is missing or stale, and the learner has
 * not just said "not now".
 */
export function shouldNudgeBackup(input: NudgeInput): boolean {
  if (input.signedIn) return false;
  if (input.persist === "granted") return false;
  if (input.eventCount < NUDGE_MIN_EVENTS) return false;
  if (
    input.dismissedAt !== undefined &&
    input.now - input.dismissedAt < NUDGE_SNOOZE_DAYS * DAY_MS
  ) {
    return false;
  }
  return (
    input.lastBackupAt === undefined || input.now - input.lastBackupAt > BACKUP_STALE_DAYS * DAY_MS
  );
}

function readTime(local: KeyValueStoreLike | undefined, key: string): number | undefined {
  try {
    const raw = local?.getItem(key);
    if (raw === null || raw === undefined) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

function writeTime(local: KeyValueStoreLike | undefined, key: string, at: number): void {
  try {
    local?.setItem(key, String(at));
  } catch {
    // Best effort: the card may come back sooner than intended.
  }
}

export const readLastBackup = (local: KeyValueStoreLike | undefined): number | undefined =>
  readTime(local, LAST_BACKUP_KEY);
export const readNudgeDismissed = (local: KeyValueStoreLike | undefined): number | undefined =>
  readTime(local, NUDGE_DISMISSED_KEY);
export const recordBackup = (local: KeyValueStoreLike | undefined, at: number): void => {
  writeTime(local, LAST_BACKUP_KEY, at);
};
export const recordNudgeDismissed = (local: KeyValueStoreLike | undefined, at: number): void => {
  writeTime(local, NUDGE_DISMISSED_KEY, at);
};

/** Record a backup made now, for pages that save a backup file without the Home card. */
export function recordBackupNow(): void {
  try {
    recordBackup(localStorage, wallNow());
  } catch {
    // Storage blocked: nothing to record.
  }
}

/** What the browser answered when persistent storage was requested ("unknown" if never asked). */
export function readPersistState(local: KeyValueStoreLike | undefined): PersistState {
  try {
    const raw = local?.getItem(PERSIST_KEY);
    if (raw === "granted") return "granted";
    if (raw === "denied") return "denied";
  } catch {
    // Storage blocked: treat as unknown.
  }
  return "unknown";
}
