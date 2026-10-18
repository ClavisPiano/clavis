import { DEFAULT_PULL_LIMIT, PullRequest, PushRequest } from "@clavis/core";
import { EventLog, QuotaExceededError, type SqlLike } from "./event-log";

/** Adapt the Durable Object storage API to `SqlLike`. */
export function durableSql(storage: DurableObjectStorage): SqlLike {
  return {
    exec: <T extends Record<string, unknown>>(query: string, ...bindings: unknown[]) =>
      storage.sql.exec(query, ...(bindings as SqlStorageValue[])).toArray() as T[],
    transaction: (fn) => storage.transactionSync(fn),
  };
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const reply = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

/**
 * Per-user event store. One instance per user (`idFromName(userId)`), so writes are serialised
 * by the runtime. The Worker authenticates and validates first; this class validates again as
 * defence in depth. Plain class (no `cloudflare:workers` import) so it also loads under Node.
 */
export class UserEvents {
  private readonly log: EventLog;

  constructor(ctx: DurableObjectState) {
    this.log = new EventLog(durableSql(ctx.storage));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/push" && request.method === "POST") {
      const parsed = PushRequest.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return reply({ error: "invalid_request" }, 400);
      // Date.now is fine here: this is the Worker, not core.
      try {
        return reply(this.log.push(parsed.data.events, Date.now()));
      } catch (error) {
        // 403 is a verdict on the account, not the batch: the client reports it and keeps pulling.
        if (error instanceof QuotaExceededError) return reply({ error: "quota_exceeded" }, 403);
        throw error;
      }
    }
    if (url.pathname === "/pull" && request.method === "GET") {
      const parsed = PullRequest.safeParse(Object.fromEntries(url.searchParams));
      if (!parsed.success) return reply({ error: "invalid_request" }, 400);
      return reply(this.log.pull(parsed.data.after, parsed.data.limit ?? DEFAULT_PULL_LIMIT));
    }
    return reply({ error: "not_found" }, 404);
  }
}
