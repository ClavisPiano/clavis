/**
 * Developer tools access in an installed PWA, where the address bar is not available. Tapping the
 * version in Settings `DEV_TOOLS_TAPS` times in a row turns on a "Developer tools" link there. The
 * choice is per device (localStorage), like the input preference, and is never part of the event log.
 */

export const DEV_TOOLS_STORAGE_KEY = "clavisDevTools";
export const DEV_TOOLS_TAPS = 7;
/** Taps further apart than this start the count again. */
export const DEV_TOOLS_TAP_GAP_MS = 1500;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function storage(): Store | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function devToolsEnabled(store: Store | undefined = storage()): boolean {
  try {
    return store?.getItem(DEV_TOOLS_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setDevToolsEnabled(on: boolean, store: Store | undefined = storage()): void {
  try {
    if (on) store?.setItem(DEV_TOOLS_STORAGE_KEY, "1");
    else store?.removeItem(DEV_TOOLS_STORAGE_KEY);
  } catch {
    // Storage blocked: the toggle simply does not persist.
  }
}

/** Counts quick consecutive taps. `tap(now)` returns true on the tap that completes the run. */
export function createTapCounter(
  taps = DEV_TOOLS_TAPS,
  gapMs = DEV_TOOLS_TAP_GAP_MS,
): { tap(nowMs: number): boolean } {
  let count = 0;
  let last = Number.NEGATIVE_INFINITY;
  return {
    tap(nowMs: number): boolean {
      count = nowMs - last > gapMs ? 1 : count + 1;
      last = nowMs;
      if (count < taps) return false;
      count = 0;
      last = Number.NEGATIVE_INFINITY;
      return true;
    },
  };
}
