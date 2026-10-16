/**
 * The small async SQL surface the auth repository needs. D1 is async (`prepare().bind().run()`),
 * so the repository is written against this interface. Production wraps D1 with `d1Sql`; tests
 * use a Node 22 `node:sqlite` implementation (see `test-support.ts`).
 */
export interface Statement {
  query: string;
  bindings: unknown[];
}

export interface AsyncSql {
  all<T extends Record<string, unknown>>(query: string, ...bindings: unknown[]): Promise<T[]>;
  run(query: string, ...bindings: unknown[]): Promise<void>;
  /** Run statements atomically, in order. */
  batch(statements: Statement[]): Promise<void>;
}

/** D1 wants ArrayBuffer for BLOBs; typed arrays are copied into a standalone buffer. */
function toD1Value(value: unknown): unknown {
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  }
  return value;
}

export function d1Sql(db: D1Database): AsyncSql {
  const prepare = (query: string, bindings: unknown[]) =>
    db.prepare(query).bind(...bindings.map(toD1Value));
  return {
    all: async <T extends Record<string, unknown>>(query: string, ...bindings: unknown[]) => {
      const res = await prepare(query, bindings).all<T>();
      return res.results;
    },
    run: async (query, ...bindings) => {
      await prepare(query, bindings).run();
    },
    batch: async (statements) => {
      await db.batch(statements.map((s) => prepare(s.query, s.bindings)));
    },
  };
}
