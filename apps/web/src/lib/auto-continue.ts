/** Device meta key for "move on by itself after a correct answer". Device-local, never synced. */
export const AUTO_CONTINUE_META_KEY = "autoContinueSec";

/** Seconds to wait after a correct answer before the next exercise. 0 turns it off. */
export const AUTO_CONTINUE_DEFAULT_SEC = 3;
export const AUTO_CONTINUE_MAX_SEC = 10;

/** A stored value, or the default when nothing valid is stored. Whole seconds, 0 to the maximum. */
export function parseAutoContinueSec(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return AUTO_CONTINUE_DEFAULT_SEC;
  return Math.min(AUTO_CONTINUE_MAX_SEC, Math.max(0, Math.round(raw)));
}
