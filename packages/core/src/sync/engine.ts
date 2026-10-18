import type { LearningEvent } from "../events/schema.js";
import { parseEvent } from "../events/schema.js";
import type { EventStore } from "../events/store.js";
import { compareEvents } from "../events/validate.js";
import { LEARNER_SNAPSHOT_KEY } from "../state/snapshot.js";
import {
  MAX_PUSH_BATCH,
  type PullResponse,
  type PushRequest,
  type PushResponse,
} from "./schema.js";

/*
 * Client sync engine (T4.3). Transport-agnostic and free of clocks: callers stamp times.
 *
 * Order is always the device `(at, id)` order. Server time and `serverSeq` are only used as the
 * pull cursor, never to reorder events.
 *
 * Error policy:
 * - `SyncAuthError` (401): stop, outcome `signedOut`, nothing is marked synced. No retry here.
 * - `SyncRejectedError` (other 4xx, notably 400 for a malformed batch): stop with outcome
 *   `error`. Nothing is marked synced and the same batch is retried on the next trigger. A
 *   permanently bad event therefore blocks pushing newer ones (it never loops within a run);
 *   this is deliberate, since silently dropping or reordering would lose data. The rejected
 *   batch is passed to `onRejected` for logging, and T4.4 can surface the error. The pull still
 *   runs, so the device keeps receiving other devices' events.
 * - Anything else thrown by the transport (network failure, 5xx): outcome `offline`; retry later.
 */

export class SyncAuthError extends Error {
  override readonly name = "SyncAuthError";
}

export class SyncRejectedError extends Error {
  override readonly name = "SyncRejectedError";
  readonly status: number;
  constructor(status: number, message?: string) {
    super(message ?? `sync request rejected with status ${String(status)}`);
    this.status = status;
  }
}

export interface SyncTransport {
  push(request: PushRequest): Promise<PushResponse>;
  pull(args: { after: number; limit?: number }): Promise<PullResponse>;
}

export interface SyncCursorStore {
  get(): Promise<number>;
  set(serverSeq: number): Promise<void>;
}

/** The slice of `LearnerStateService` the engine needs: append refolds as required. */
export interface SyncLearner {
  append(events: LearningEvent[]): Promise<unknown>;
}

export const SYNC_CURSOR_META_KEY = "sync.cursor";

/** Cursor persisted in the event store's device-local meta. */
export function metaCursorStore(store: EventStore): SyncCursorStore {
  return {
    async get() {
      const v = await store.getMeta(SYNC_CURSOR_META_KEY);
      return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0;
    },
    async set(serverSeq) {
      await store.setMeta(SYNC_CURSOR_META_KEY, serverSeq);
    },
  };
}

export type SyncOutcome = "ok" | "signedOut" | "offline" | "error";

export interface SyncResult {
  outcome: SyncOutcome;
  /** Events sent to the server (accepted or already held), now marked synced. */
  pushed: number;
  /** Pulled events that were new to this device. */
  pulledNew: number;
  /** Pulled events this build could not parse (kept on the server, not stored here). */
  skipped: number;
  /** Set for `error` and `offline`. */
  detail?: string;
  /** Events the server cannot take because they are too large alone. They stay unsynced. */
  oversized?: number;
}

/**
 * Largest serialized push body the client builds. The Worker refuses 2 MiB, so this leaves room for
 * the envelope and for multi-byte characters counted as UTF-16 units.
 */
export const MAX_PUSH_BYTES = 1024 * 1024;

/** UTF-8 length of a string (core has no TextEncoder typing). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

const eventBytes = (event: LearningEvent): number => utf8Length(JSON.stringify(event));

/**
 * Split events (in order) into chunks whose serialized JSON array stays within `maxBytes`. An event
 * larger than the cap on its own still gets a chunk of its own: the server decides whether it fits
 * (a 413 then makes `pushChunk` skip it). The web app's `MAX_IMPORT_EVENT_BYTES` is this same constant.
 */
export function chunkByBytes(
  events: readonly LearningEvent[],
  maxBytes: number = MAX_PUSH_BYTES,
): LearningEvent[][] {
  const chunks: LearningEvent[][] = [];
  let current: LearningEvent[] = [];
  let size = 2; // the surrounding [ ]
  for (const event of events) {
    const bytes = eventBytes(event) + (current.length > 0 ? 1 : 0); // comma between items
    if (current.length > 0 && size + bytes > maxBytes) {
      chunks.push(current);
      current = [];
      size = 2;
    }
    current.push(event);
    size += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export interface SyncDeps {
  store: EventStore;
  learner: SyncLearner;
  transport: SyncTransport;
  cursorStore: SyncCursorStore;
  pushBatch?: number;
  /** Cap on a push body in bytes. Defaults to `MAX_PUSH_BYTES`. */
  maxPushBytes?: number;
  pullLimit?: number;
  /** Called with the rejected batch when the server refuses it (diagnostics). */
  onRejected?: (events: LearningEvent[], error: SyncRejectedError) => void;
  /** Called with an event too large to push, which is skipped so it cannot block newer events. */
  onOversized?: (event: LearningEvent) => void;
}

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function syncOnce(deps: SyncDeps): Promise<SyncResult> {
  const result: SyncResult = { outcome: "ok", pushed: 0, pulledNew: 0, skipped: 0 };
  try {
    let rejected: SyncRejectedError | undefined;
    try {
      await pushAll(deps, result);
    } catch (error) {
      if (!(error instanceof SyncRejectedError)) throw error;
      // A rejected batch must not cut this device off from other devices' events.
      rejected = error;
    }
    await pullAll(deps, result);
    if (rejected) throw rejected;
  } catch (error) {
    if (error instanceof SyncAuthError) result.outcome = "signedOut";
    else if (error instanceof SyncRejectedError) {
      result.outcome = "error";
      result.detail = error.message;
    } else {
      result.outcome = "offline";
      result.detail = describe(error);
    }
  }
  return result;
}

async function pushAll(deps: SyncDeps, result: SyncResult): Promise<void> {
  const size = Math.min(deps.pushBatch ?? MAX_PUSH_BATCH, MAX_PUSH_BATCH);
  // Events the server refused even alone. They stay unsynced but are passed over for this run.
  const skipped = new Set<string>();
  for (;;) {
    const unsynced = await deps.store.listUnsynced(size + skipped.size);
    const batch = unsynced.filter((e) => !skipped.has(e.id)).slice(0, size);
    if (batch.length === 0) return;
    for (const chunk of chunkByBytes(batch, deps.maxPushBytes)) {
      await pushChunk(deps, chunk, result, skipped);
    }
  }
}

/** Push one chunk. A 413 halves it; a single event that still gets 413 is skipped, not retried. */
async function pushChunk(
  deps: SyncDeps,
  chunk: LearningEvent[],
  result: SyncResult,
  skipped: Set<string>,
): Promise<void> {
  try {
    await deps.transport.push({ events: chunk });
  } catch (error) {
    if (error instanceof SyncRejectedError && error.status === 413) {
      const [only] = chunk;
      if (only && chunk.length === 1) {
        skipped.add(only.id);
        result.oversized = skipped.size;
        deps.onOversized?.(only);
        return;
      }
      const mid = Math.ceil(chunk.length / 2);
      await pushChunk(deps, chunk.slice(0, mid), result, skipped);
      await pushChunk(deps, chunk.slice(mid), result, skipped);
      return;
    }
    if (error instanceof SyncRejectedError) deps.onRejected?.(chunk, error);
    throw error;
  }
  await deps.store.markSynced(chunk.map((e) => e.id));
  result.pushed += chunk.length;
}

async function pullAll(deps: SyncDeps, result: SyncResult): Promise<void> {
  let after = await deps.cursorStore.get();
  for (;;) {
    const page = await deps.transport.pull({
      after,
      ...(deps.pullLimit === undefined ? {} : { limit: deps.pullLimit }),
    });
    const events: LearningEvent[] = [];
    for (const entry of page.events) {
      const parsed = parseEvent(entry.event);
      if (parsed.ok) events.push(parsed.event);
      else result.skipped++;
    }
    await applyPulled(deps, events, result);
    const last = page.events.at(-1);
    // Guard against a server that reports more without advancing: never loop on one cursor.
    const next = last ? Math.max(last.serverSeq, after) : after;
    if (next !== after) await deps.cursorStore.set(next);
    if (!page.hasMore || next === after) return;
    after = next;
  }
}

async function applyPulled(
  deps: SyncDeps,
  events: LearningEvent[],
  result: SyncResult,
): Promise<void> {
  const sorted = [...new Map(events.map((e) => [e.id, e])).values()].sort(compareEvents);
  const earliest = sorted[0];
  if (!earliest) return;
  const known = new Set((await deps.store.list({ fromAt: earliest.at })).map((e) => e.id));
  const fresh = sorted.filter((e) => !known.has(e.id));
  const first = fresh[0];
  if (first) {
    const snap = await deps.store.getSnapshot(LEARNER_SNAPSHOT_KEY);
    // A stored snapshot already past the new events would hide them on the next load.
    if (snap && compareEvents(first, { at: snap.lastEventAt, id: snap.lastEventId }) <= 0) {
      await deps.store.clearSnapshots();
    }
    // The learner appends and refolds from scratch when events land before its head.
    await deps.learner.append(fresh);
    result.pulledNew += fresh.length;
  }
  // The server has all of these, so they never need pushing (append stores events as unsynced).
  await deps.store.markSynced(sorted.map((e) => e.id));
}
