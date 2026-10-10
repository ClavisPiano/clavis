import type { LearningEvent } from "./schema.js";

export interface Snapshot {
  key: string;
  reducerVersion: number;
  contentVersion: string;
  lastEventAt: number;
  lastEventId: string;
  state: unknown;
}

export interface ListOptions {
  /** Only events with `at >= fromAt`. */
  fromAt?: number;
  /** Only events strictly after this event in (at, id) order. Rejects if the id is unknown. */
  afterId?: string;
  limit?: number;
}

/**
 * Local event log plus device-local derived data. All methods are async.
 * Events are ordered by (at, id) ascending everywhere.
 */
export interface EventStore {
  /**
   * Validate and insert events. Idempotent on `id`: events whose id is already
   * stored (or repeated within the batch) are ignored, not errors.
   *
   * Batches are all-or-nothing on validation: if ANY event is invalid the
   * promise rejects with `InvalidEventError` and nothing from the batch is inserted.
   */
  append(events: LearningEvent[]): Promise<{ inserted: number }>;
  list(opts?: ListOptions): Promise<LearningEvent[]>;
  listUnsynced(limit?: number): Promise<LearningEvent[]>;
  /** Unknown ids are ignored. */
  markSynced(ids: string[]): Promise<void>;
  getSnapshot(key: string): Promise<Snapshot | undefined>;
  putSnapshot(snapshot: Snapshot): Promise<void>;
  clearSnapshots(): Promise<void>;
  /** Small device-local values (device id, later latency calibration). */
  getMeta(key: string): Promise<unknown>;
  setMeta(key: string, value: unknown): Promise<void>;
  /** Remove events, snapshots and meta. For tests and import. */
  clear(): Promise<void>;
}

export class InvalidEventError extends Error {
  override readonly name = "InvalidEventError";
  readonly index: number;
  constructor(index: number, detail: string) {
    super(`invalid event at index ${String(index)}: ${detail}`);
    this.index = index;
  }
}
