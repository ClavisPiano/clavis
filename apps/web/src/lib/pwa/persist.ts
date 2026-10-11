export const PERSIST_KEY = "clavis.storage-persist";

export interface StorageManagerLike {
  persist?: () => Promise<boolean>;
}

export interface KeyValueStoreLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type PersistOutcome = "granted" | "denied" | "unsupported" | "already-requested";

/**
 * Asks the browser once to treat our storage as persistent (so IndexedDB is not evicted). The
 * result is recorded in localStorage so later loads do not ask again. Never throws.
 */
export async function requestPersistentStorage(
  storage: StorageManagerLike | undefined,
  local: KeyValueStoreLike | undefined,
): Promise<PersistOutcome> {
  try {
    if (local?.getItem(PERSIST_KEY) != null) return "already-requested";
  } catch {
    // Storage blocked: fall through and ask; worst case we ask again next load.
  }

  if (!storage || typeof storage.persist !== "function") return "unsupported";

  let granted: boolean;
  try {
    granted = await storage.persist();
  } catch {
    return "denied";
  }

  try {
    local?.setItem(PERSIST_KEY, granted ? "granted" : "denied");
  } catch {
    // Ignore: recording is best effort.
  }
  return granted ? "granted" : "denied";
}
