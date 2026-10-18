/*
 * T8.4: the time events are stamped with. Events are ordered by their `at` forever, so a device
 * whose clock is far in the future would make its events sort last on every device. The server's
 * clock is the reference: each sync response carries a `Date` header, from which we learn how far
 * this device is from it. Only a device clock AHEAD of the server by more than a day is corrected,
 * because that is the case that wrecks ordering. A small drift, or a clock behind the server, is
 * left alone: events stay in the learner's own time.
 */

export const SKEW_KEY = "clavis.clock-skew-ms";
/** The device time when the skew was observed, to notice a clock that has since been changed. */
export const SKEW_AT_KEY = "clavis.clock-skew-at";
/**
 * If the device clock now reads earlier than it did at the observation by more than this, the
 * person changed it (for example fixed a clock that was days ahead), so the stored skew is stale.
 * Small steps backward are normal clock adjustment and are tolerated.
 */
export const CLOCK_JUMP_BACK_MS = 5 * 60_000;
/** Ahead of the server by more than this and the clock is corrected. */
export const MAX_AHEAD_MS = 86_400_000;

interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function local(): Store | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Server time minus device time in ms, as last observed. 0 when unknown, or when the device clock
 * has been set back since the observation (the skew described a clock that no longer exists).
 */
export function readSkew(
  store: Store | undefined = local(),
  deviceNowMs: number = Date.now(),
): number {
  try {
    const raw = store?.getItem(SKEW_KEY);
    const n = raw == null ? 0 : Number(raw);
    if (!Number.isFinite(n)) return 0;
    const at = Number(store?.getItem(SKEW_AT_KEY));
    if (Number.isFinite(at) && at > 0 && deviceNowMs < at - CLOCK_JUMP_BACK_MS) return 0;
    return n;
  } catch {
    return 0;
  }
}

/** Remember how far the device clock is from the server's, from a response `Date` header. */
export function observeServerDate(
  dateHeader: string | null,
  deviceNowMs: number = Date.now(),
  store: Store | undefined = local(),
): void {
  if (dateHeader === null) return;
  const serverMs = Date.parse(dateHeader);
  if (Number.isNaN(serverMs)) return;
  try {
    store?.setItem(SKEW_KEY, String(serverMs - deviceNowMs));
    store?.setItem(SKEW_AT_KEY, String(deviceNowMs));
  } catch {
    // Storage blocked: stamping simply stays on the device clock. A skew with no observation time
    // could never be told stale, so do not leave one behind if only the first write succeeded.
    try {
      store?.removeItem(SKEW_KEY);
    } catch {
      // Nothing more to do.
    }
  }
}

/** The device time corrected for skew, only when the device is more than a day ahead. */
export function correctedNow(deviceNowMs: number, skewMs: number): number {
  return skewMs < -MAX_AHEAD_MS ? deviceNowMs + skewMs : deviceNowMs;
}

/** The time to stamp events and compute learner days with. */
export function wallNow(): number {
  return correctedNow(Date.now(), readSkew());
}
