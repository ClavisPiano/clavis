import {
  DEFAULT_PULL_LIMIT,
  type PullResponse,
  type PushResponse,
  type SyncEnvelope,
} from "@clavis/core";

/**
 * The slice of the Durable Object SQLite API the event log needs. In production it is backed by
 * `ctx.storage.sql` and `ctx.storage.transactionSync`; tests back it with `node:sqlite`.
 */
export interface SqlLike {
  /** Run one statement and return all result rows. */
  exec<T extends Record<string, unknown>>(query: string, ...bindings: unknown[]): T[];
  /** Run `fn` atomically; a throw rolls back. */
  transaction<T>(fn: () => T): T;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  at INTEGER NOT NULL,
  body TEXT NOT NULL,
  received_at INTEGER NOT NULL
)`;

/** Append-only, idempotent event log for one user. The caller serialises access (a DO does). */
export class EventLog {
  constructor(private readonly sql: SqlLike) {
    sql.exec(SCHEMA);
  }

  push(events: readonly SyncEnvelope[], receivedAt: number): PushResponse {
    return this.sql.transaction(() => {
      let accepted = 0;
      for (const event of events) {
        const rows = this.sql.exec<{ seq: number }>(
          // The NOT EXISTS guard keeps seqs gap free (an ignored insert would still burn a rowid
          // under AUTOINCREMENT); OR IGNORE backs it up on the UNIQUE constraint.
          `INSERT OR IGNORE INTO events (id, at, body, received_at)
           SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM events WHERE id = ?)
           RETURNING seq`,
          event.id,
          event.at,
          JSON.stringify(event),
          receivedAt,
          event.id,
        );
        if (rows.length > 0) accepted++;
      }
      const last = this.sql.exec<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM events");
      return { accepted, duplicates: events.length - accepted, lastSeq: last[0]?.seq ?? 0 };
    });
  }

  pull(after: number, limit: number = DEFAULT_PULL_LIMIT): PullResponse {
    const rows = this.sql.exec<{ seq: number; body: string; received_at: number }>(
      "SELECT seq, body, received_at FROM events WHERE seq > ? ORDER BY seq LIMIT ?",
      after,
      limit + 1,
    );
    const page = rows.slice(0, limit);
    return {
      events: page.map((r) => ({
        serverSeq: r.seq,
        receivedAt: r.received_at,
        event: JSON.parse(r.body) as SyncEnvelope,
      })),
      lastSeq: page.at(-1)?.seq ?? after,
      hasMore: rows.length > limit,
    };
  }
}
