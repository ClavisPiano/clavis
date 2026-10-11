import { initAppStore } from "./app-store";

/** Device meta key holding the calibration. Device-local: meta is never synced. */
export const LATENCY_META_KEY = "latency";

/** Shape stored under `LATENCY_META_KEY`. The session runner reads the same key. */
export interface LatencyMeta {
  /** Tap path: output plus human/touch latency, subtract from tap onsets. */
  tapMs?: number;
  /** Mic path: output plus input latency through speaker and mic. */
  micMs?: number;
  measuredAt: number;
  userAgent: string;
}

export interface LatencyOffsets {
  tapMs?: number;
  micMs?: number;
}

/** The slice of `EventStore` used here. */
export interface MetaStore {
  getMeta(key: string): Promise<unknown>;
  setMeta(key: string, value: unknown): Promise<void>;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Validates stored data; anything malformed yields undefined (treated as "not calibrated"). */
export function parseLatencyMeta(raw: unknown): LatencyMeta | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as { measuredAt?: unknown; userAgent?: unknown; tapMs?: unknown; micMs?: unknown };
  if (!finite(r.measuredAt) || typeof r.userAgent !== "string") return undefined;
  const meta: LatencyMeta = { measuredAt: r.measuredAt, userAgent: r.userAgent };
  if (finite(r.tapMs)) meta.tapMs = r.tapMs;
  if (finite(r.micMs)) meta.micMs = r.micMs;
  return meta;
}

export async function readLatency(store: MetaStore): Promise<LatencyMeta | undefined> {
  return parseLatencyMeta(await store.getMeta(LATENCY_META_KEY));
}

export interface SaveDeps {
  now: () => number;
  userAgent: string;
}

/**
 * Merges new measurements over the saved ones (measuring only the tap path keeps an earlier mic
 * value) and writes the result. Returns what was written.
 */
export async function saveLatency(
  store: MetaStore,
  update: LatencyOffsets,
  deps: SaveDeps,
): Promise<LatencyMeta> {
  const previous = await readLatency(store);
  const tapMs = update.tapMs ?? previous?.tapMs;
  const micMs = update.micMs ?? previous?.micMs;
  const next: LatencyMeta = {
    ...(tapMs === undefined ? {} : { tapMs }),
    ...(micMs === undefined ? {} : { micMs }),
    measuredAt: deps.now(),
    userAgent: deps.userAgent,
  };
  await store.setMeta(LATENCY_META_KEY, next);
  return next;
}

/** Forget the calibration. The store has no delete, so a null marker is written. */
export async function resetLatency(store: MetaStore): Promise<void> {
  await store.setMeta(LATENCY_META_KEY, null);
}

export function toOffsets(meta: LatencyMeta | undefined): LatencyOffsets {
  const out: LatencyOffsets = {};
  if (meta?.tapMs !== undefined) out.tapMs = meta.tapMs;
  if (meta?.micMs !== undefined) out.micMs = meta.micMs;
  return out;
}

/** Saved per-device offsets, or `{}` when never calibrated or storage is unavailable. */
export async function getLatencyOffsets(): Promise<LatencyOffsets> {
  const result = await initAppStore();
  if (!result.ok) return {};
  return toOffsets(await readLatency(result.store));
}

/** Test hook, installed on `/settings/latency?test=1` only. */
export interface LatencyTestHook {
  clickTimesMs: () => number[];
  injectTap: (contextMs: number) => void;
}

declare global {
  interface Window {
    __clavisLatency?: LatencyTestHook;
  }
}
