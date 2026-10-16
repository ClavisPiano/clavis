import { DatabaseSync } from "node:sqlite";
import type { SqlLike } from "./event-log";
import { UserEvents } from "./user-events";
import type { Env } from "./index";

/** `SqlLike` over an in-memory Node SQLite database (same engine family as DO storage). */
export function nodeSql(db: DatabaseSync = new DatabaseSync(":memory:")): SqlLike {
  return {
    exec: <T extends Record<string, unknown>>(query: string, ...bindings: unknown[]) =>
      db.prepare(query).all(...bindings) as T[],
    transaction: <R>(fn: () => R): R => {
      db.exec("BEGIN");
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

/** Fake `DurableObjectState` exposing just what `UserEvents` touches, backed by Node SQLite. */
function fakeState(): DurableObjectState {
  const sql = nodeSql();
  const storage = {
    sql: { exec: (q: string, ...b: unknown[]) => ({ toArray: () => sql.exec(q, ...b) }) },
    transactionSync: <R>(fn: () => R): R => sql.transaction(fn),
  };
  return { storage } as unknown as DurableObjectState;
}

/** In-memory `USER_EVENTS` namespace: one real `UserEvents` per name. */
export function fakeNamespace(): DurableObjectNamespace {
  const objects = new Map<string, UserEvents>();
  const ns = {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => {
      let obj = objects.get(id.name);
      if (!obj) {
        obj = new UserEvents(fakeState());
        objects.set(id.name, obj);
      }
      const target = obj;
      return {
        fetch: (input: string, init?: RequestInit) => target.fetch(new Request(input, init)),
      };
    },
  };
  return ns as unknown as DurableObjectNamespace;
}

export const SECRET = "test-secret-not-real";

export function makeEnv(overrides: Partial<Env> = {}): { env: Env; seen: string[] } {
  const seen: string[] = [];
  const ASSETS = {
    fetch: (input: Request | string | URL) => {
      const req = input instanceof Request ? input : new Request(input);
      seen.push(new URL(req.url).pathname);
      return Promise.resolve(new Response("asset", { status: 200 }));
    },
  };
  // The fakes only implement the parts of the bindings the worker uses.
  const env: Env = {
    ASSETS: ASSETS as unknown as Fetcher,
    VERSION: "abc123",
    USER_EVENTS: fakeNamespace(),
    SESSION_SECRET: SECRET,
    ...overrides,
  };
  return { env, seen };
}
