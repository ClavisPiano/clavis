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

/** Running totals, so a push does not have to scan the log to know how big it is. */
const STATS_SCHEMA = `CREATE TABLE IF NOT EXISTS stats (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  events INTEGER NOT NULL,
  bytes INTEGER NOT NULL
)`;

/** Per-user ceilings. Generous for a real learner (about 70k events a year), a wall for abuse. */
export interface EventLogLimits {
  maxEvents: number;
  maxBytes: number;
}

export const DEFAULT_LIMITS: EventLogLimits = { maxEvents: 500_000, maxBytes: 256 * 1024 * 1024 };

export class QuotaExceededError extends Error {
  override readonly name = "QuotaExceededError";
}

/** Append-only, idempotent event log for one user. The caller serialises access (a DO does). */
export class EventLog {
  constructor(
    private readonly sql: SqlLike,
    private readonly limits: EventLogLimits = DEFAULT_LIMITS,
  ) {
    sql.exec(SCHEMA);
    sql.exec(STATS_SCHEMA);
    // Logs written before the stats table existed are counted once.
    sql.exec(
      `INSERT OR IGNORE INTO stats (id, events, bytes)
       SELECT 1, COUNT(*), COALESCE(SUM(LENGTH(CAST(body AS BLOB))), 0) FROM events`,
    );
  }

  push(events: readonly SyncEnvelope[], receivedAt: number): PushResponse {
    return this.sql.transaction(() => {
      let accepted = 0;
      let addedBytes = 0;
      for (const event of events) {
        const body = JSON.stringify(event);
        const rows = this.sql.exec<{ seq: number }>(
          // The NOT EXISTS guard keeps seqs gap free (an ignored insert would still burn a rowid
          // under AUTOINCREMENT); OR IGNORE backs it up on the UNIQUE constraint.
          `INSERT OR IGNORE INTO events (id, at, body, received_at)
           SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM events WHERE id = ?)
           RETURNING seq`,
          event.id,
          event.at,
          body,
          receivedAt,
          event.id,
        );
        if (rows.length > 0) {
          accepted++;
          addedBytes += utf8Length(body);
        }
      }
      if (accepted > 0) {
        const [stats] = this.sql.exec<{ events: number; bytes: number }>(
          "UPDATE stats SET events = events + ?, bytes = bytes + ? WHERE id = 1 RETURNING events, bytes",
          accepted,
          addedBytes,
        );
        // Throwing inside the transaction rolls the whole batch back.
        if (stats && (stats.events > this.limits.maxEvents || stats.bytes > this.limits.maxBytes)) {
          throw new QuotaExceededError("event storage quota exceeded");
        }
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

/** UTF-8 length of a string. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}
