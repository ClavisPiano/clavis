import {
  compareEvents,
  validateBatch,
  type EventStore,
  type LearningEvent,
  type ListOptions,
  type Snapshot,
} from "@clavis/core";
import { Dexie, type Table } from "dexie";
import {
  DexieBlobStore,
  type BlobRecord,
  type BlobStore,
  type BlobStoreOptions,
} from "./blob-store.js";

/** Stored event row: the event plus a 0/1 flag (booleans are not indexable in IndexedDB). */
type EventRow = LearningEvent & { synced: 0 | 1 };
interface MetaRow {
  key: string;
  value: unknown;
}

export interface DexieEventStoreOptions {
  /** Database name. Defaults to "clavis". Tests pass a unique name per store. */
  name?: string;
  /** Override the IndexedDB implementation (tests use fake-indexeddb). */
  indexedDB?: IDBFactory;
  IDBKeyRange?: typeof IDBKeyRange;
}

function toEvent(row: EventRow): LearningEvent {
  const event: Partial<EventRow> = { ...row };
  delete event.synced;
  return event as LearningEvent;
}

export class DexieEventStore implements EventStore {
  private readonly db: Dexie & {
    events: Table<EventRow, string>;
    snapshots: Table<Snapshot, string>;
    meta: Table<MetaRow, string>;
    blobs: Table<BlobRecord, string>;
  };

  constructor(options: DexieEventStoreOptions = {}) {
    const { name = "clavis", ...rest } = options;
    const db = new Dexie(name, {
      ...(rest.indexedDB ? { indexedDB: rest.indexedDB } : {}),
      ...(rest.IDBKeyRange ? { IDBKeyRange: rest.IDBKeyRange } : {}),
    });
    db.version(1).stores({
      events: "id, at, [at+id], synced",
      snapshots: "key",
      meta: "key",
    });
    // v2 (T4.5) adds recordings. Existing tables carry over untouched; no data migration is needed
    // because the new table starts empty.
    db.version(2).stores({
      events: "id, at, [at+id], synced",
      snapshots: "key",
      meta: "key",
      blobs: "key, createdAt",
    });
    this.db = db as typeof this.db;
  }

  /** Local recordings (T4.5) in the same database. */
  blobStore(options?: BlobStoreOptions): BlobStore {
    return new DexieBlobStore(this.db, this.db.blobs, options);
  }

  close(): void {
    this.db.close();
  }

  async append(events: LearningEvent[]): Promise<{ inserted: number }> {
    // Validate everything before opening a transaction: all-or-nothing.
    const valid = validateBatch(events);
    const unique = new Map<string, LearningEvent>();
    for (const event of valid) if (!unique.has(event.id)) unique.set(event.id, event);
    const ids = [...unique.keys()];
    return this.db.transaction("rw", this.db.events, async () => {
      const existing = await this.db.events.bulkGet(ids);
      const fresh: EventRow[] = [];
      ids.forEach((id, i) => {
        const event = unique.get(id);
        if (!existing[i] && event) fresh.push({ ...event, synced: 0 });
      });
      if (fresh.length > 0) await this.db.events.bulkAdd(fresh);
      return { inserted: fresh.length };
    });
  }

  async list(opts: ListOptions = {}): Promise<LearningEvent[]> {
    const { fromAt, afterId, limit } = opts;
    const index = this.db.events.where("[at+id]");
    let collection;
    if (afterId !== undefined) {
      const cursor = await this.db.events.get(afterId);
      if (!cursor) throw new Error(`unknown afterId: ${afterId}`);
      collection = index.above([cursor.at, cursor.id]);
    } else if (fromAt !== undefined) {
      collection = index.aboveOrEqual([fromAt, ""]);
    } else {
      collection = this.db.events.orderBy("[at+id]");
    }
    if (afterId !== undefined && fromAt !== undefined) {
      collection = collection.filter((row) => row.at >= fromAt);
    }
    if (limit !== undefined) collection = collection.limit(limit);
    const rows = await collection.toArray();
    return rows.sort(compareEvents).map(toEvent);
  }

  async listUnsynced(limit?: number): Promise<LearningEvent[]> {
    let collection = this.db.events.orderBy("[at+id]").filter((row) => row.synced === 0);
    if (limit !== undefined) collection = collection.limit(limit);
    return (await collection.toArray()).map(toEvent);
  }

  async markSynced(ids: string[]): Promise<void> {
    await this.db.events.where("id").anyOf(ids).modify({ synced: 1 });
  }

  async markAllUnsynced(): Promise<void> {
    await this.db.events.toCollection().modify({ synced: 0 });
  }

  getSnapshot(key: string): Promise<Snapshot | undefined> {
    return Promise.resolve(this.db.snapshots.get(key));
  }

  async putSnapshot(snapshot: Snapshot): Promise<void> {
    await this.db.snapshots.put(snapshot);
  }

  async clearSnapshots(): Promise<void> {
    await this.db.snapshots.clear();
  }

  async getMeta(key: string): Promise<unknown> {
    return (await this.db.meta.get(key))?.value;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    await this.db.meta.put({ key, value });
  }

  async clear(): Promise<void> {
    await this.db.transaction("rw", this.db.events, this.db.snapshots, this.db.meta, async () => {
      await Promise.all([this.db.events.clear(), this.db.snapshots.clear(), this.db.meta.clear()]);
    });
  }
}
