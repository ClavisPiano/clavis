/*
 * T8.4: the time events are stamped with. Events are ordered by their `at` forever, so a device
 * whose clock is far in the future would make its events sort last on every device. The server's
 * clock is the reference: each sync response carries a `Date` header, from which we learn how far
 * this device is from it. Only a device clock AHEAD of the server by more than a day is corrected,
 * because that is the case that wrecks ordering. A small drift, or a clock behind the server, is
 * left alone: events stay in the learner's own time.
 */

export const SKEW_KEY = "clavis.clock-skew-ms";
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

/** Server time minus device time in ms, as last observed. 0 when unknown. */
export function readSkew(store: Store | undefined = local()): number {
  try {
    const raw = store?.getItem(SKEW_KEY);
    const n = raw == null ? 0 : Number(raw);
    return Number.isFinite(n) ? n : 0;
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
  } catch {
    // Storage blocked: stamping simply stays on the device clock.
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
