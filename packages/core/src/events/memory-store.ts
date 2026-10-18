import type { LearningEvent } from "./schema.js";
import type { EventStore, ListOptions, Snapshot } from "./store.js";
import { compareEvents, validateBatch } from "./validate.js";

export class MemoryEventStore implements EventStore {
  private events = new Map<string, LearningEvent>();
  private unsynced = new Set<string>();
  private snapshots = new Map<string, Snapshot>();
  private meta = new Map<string, unknown>();

  async append(events: LearningEvent[]): Promise<{ inserted: number }> {
    await Promise.resolve();
    const valid = validateBatch(events);
    let inserted = 0;
    for (const event of valid) {
      if (this.events.has(event.id)) continue;
      this.events.set(event.id, event);
      this.unsynced.add(event.id);
      inserted++;
    }
    return { inserted };
  }

  async list(opts: ListOptions = {}): Promise<LearningEvent[]> {
    await Promise.resolve();
    return this.sorted(opts, () => true, opts.limit);
  }

  async listUnsynced(limit?: number): Promise<LearningEvent[]> {
    await Promise.resolve();
    return this.sorted({}, (e) => this.unsynced.has(e.id), limit);
  }

  async markSynced(ids: string[]): Promise<void> {
    await Promise.resolve();
    for (const id of ids) this.unsynced.delete(id);
  }

  async markAllUnsynced(): Promise<void> {
    await Promise.resolve();
    this.unsynced = new Set(this.events.keys());
  }

  async getSnapshot(key: string): Promise<Snapshot | undefined> {
    await Promise.resolve();
    return this.snapshots.get(key);
  }

  async putSnapshot(snapshot: Snapshot): Promise<void> {
    await Promise.resolve();
    this.snapshots.set(snapshot.key, snapshot);
  }

  async clearSnapshots(): Promise<void> {
    await Promise.resolve();
    this.snapshots.clear();
  }

  async getMeta(key: string): Promise<unknown> {
    await Promise.resolve();
    return this.meta.get(key);
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    await Promise.resolve();
    this.meta.set(key, value);
  }

  async clear(): Promise<void> {
    await Promise.resolve();
    this.events.clear();
    this.unsynced.clear();
    this.snapshots.clear();
    this.meta.clear();
  }

  private sorted(
    opts: ListOptions,
    keep: (e: LearningEvent) => boolean,
    limit: number | undefined,
  ): LearningEvent[] {
    let cursor: LearningEvent | undefined;
    if (opts.afterId !== undefined) {
      cursor = this.events.get(opts.afterId);
      if (!cursor) throw new Error(`unknown afterId: ${opts.afterId}`);
    }
    const out = [...this.events.values()]
      .filter(keep)
      .filter((e) => opts.fromAt === undefined || e.at >= opts.fromAt)
      .filter((e) => cursor === undefined || compareEvents(e, cursor) > 0)
      .sort(compareEvents);
    return limit === undefined ? out : out.slice(0, limit);
  }
}
