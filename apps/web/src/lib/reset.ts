import { DEVICE_ID_META_KEY, type EventStore, type LearningEvent } from "@clavis/core";
import { PLACEMENT_SKIPPED_META_KEY } from "./placement";
import { HEADPHONES_META_KEY, ORIENT_CARD_META_KEY } from "./session/runtime";
import { LATENCY_META_KEY } from "./latency";
import { DEV_TOOLS_STORAGE_KEY } from "./dev-tools";

/*
 * Dev-only resets for testing on a device (reached from /dev/reset). Both rewrite the local store
 * through the plain `EventStore` API; the caller reloads the page afterwards so the app-wide
 * learner state is rebuilt from what is left.
 */

/** Events that describe the device and its setup rather than learning. Kept by `resetProgress`. */
const SETUP_EVENT_TYPES: ReadonlySet<LearningEvent["type"]> = new Set([
  "device.registered",
  "settings.changed",
]);

/** Device meta that belongs to learning progress, cleared by `resetProgress`. */
const PROGRESS_META_KEYS: readonly string[] = [PLACEMENT_SKIPPED_META_KEY, ORIENT_CARD_META_KEY];

export interface ResetResult {
  kept: number;
  removed: number;
}

/**
 * Remove learning progress (sessions, items, attempts, introductions, placements) and keep the
 * setup: device registration, settings and device meta such as latency and headphones. The first-run
 * placement offer and the orient card come back. Snapshots are dropped so the state is refolded.
 */
export async function resetProgress(store: EventStore): Promise<ResetResult> {
  const events = await store.list();
  const keep = events.filter((e) => SETUP_EVENT_TYPES.has(e.type));
  const meta = await readMetaExcept(store, PROGRESS_META_KEYS);
  await store.clear();
  if (keep.length > 0) await store.append(keep);
  for (const [key, value] of meta) await store.setMeta(key, value);
  return { kept: keep.length, removed: events.length - keep.length };
}

/**
 * Remove everything local, as after a fresh install: events, snapshots, device meta (including the
 * device id, so a new device is registered on reload) and this app's localStorage. The developer
 * tools switch is kept so the tester can get back to /dev.
 */
export async function resetEverything(
  store: EventStore,
  local: Pick<Storage, "length" | "key" | "removeItem"> | undefined,
): Promise<void> {
  await store.clear();
  if (!local) return;
  const keys: string[] = [];
  for (let i = 0; i < local.length; i++) {
    const key = local.key(i);
    if (key !== null && key !== DEV_TOOLS_STORAGE_KEY) keys.push(key);
  }
  for (const key of keys) local.removeItem(key);
}

/** Meta keys the app writes. `EventStore` has no way to list meta, so they are named here. */
const KNOWN_META_KEYS: readonly string[] = [
  DEVICE_ID_META_KEY,
  HEADPHONES_META_KEY,
  LATENCY_META_KEY,
  PLACEMENT_SKIPPED_META_KEY,
  ORIENT_CARD_META_KEY,
];

async function readMetaExcept(
  store: EventStore,
  drop: readonly string[],
): Promise<[string, unknown][]> {
  const out: [string, unknown][] = [];
  for (const key of KNOWN_META_KEYS) {
    if (drop.includes(key)) continue;
    const value = await store.getMeta(key);
    if (value !== undefined) out.push([key, value]);
  }
  return out;
}
