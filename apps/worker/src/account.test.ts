import { describe, expect, it } from "vitest";
import { signSession } from "./auth/session";
import worker, { type Env } from "./index";
import { ORIGIN, SECRET, fakeBucket, makeEnv } from "./test-support";

const call = (path: string, env: Env, init?: RequestInit) =>
  worker.fetch(new Request(`${ORIGIN}${path}`, init), env);

const bearer = async (sub: string) => ({
  authorization: `Bearer ${await signSession({ sub, exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET)}`,
});

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = (n: number): string => {
  let s = "";
  let rest = n;
  for (let i = 0; i < 16; i++) {
    s = ALPHABET.charAt(rest % 32) + s;
    rest = Math.floor(rest / 32);
  }
  return `01ARYZ6S41${s}`;
};
const ev = (n: number) => ({
  id: ulid(n),
  deviceId: "dev1",
  at: 1_700_000_000_000 + n,
  type: "device.registered",
  v: 1,
  platform: "web",
});

async function seed(env: Env, sub: string, events: number, recordings: string[]) {
  const res = await call("/api/sync/push", env, {
    method: "POST",
    headers: { ...(await bearer(sub)), "content-type": "application/json" },
    body: JSON.stringify({ events: Array.from({ length: events }, (_, i) => ev(i + 1)) }),
  });
  expect(res.status).toBe(200);
  for (const name of recordings) {
    await env.BLOBS.put(`${sub}/${name}`, new Uint8Array([1, 2, 3]));
  }
}

const del = async (env: Env, sub: string, origin: string | null = ORIGIN) =>
  call("/api/me", env, {
    method: "DELETE",
    headers: { ...(await bearer(sub)), ...(origin === null ? {} : { origin }) },
  });

const exportOf = async (env: Env, sub: string) =>
  call("/api/me/export", env, { headers: await bearer(sub) });

const userRow = (env: Env, id: string) =>
  env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(id).all();

describe("DELETE /api/me", () => {
  it("needs a session and the exact Origin", async () => {
    const { env } = makeEnv();
    expect(
      (await call("/api/me", env, { method: "DELETE", headers: { origin: ORIGIN } })).status,
    ).toBe(401);
    expect((await del(env, "u1", null)).status).toBe(403);
    expect((await del(env, "u1", "https://evil.example")).status).toBe(403);
    expect((await userRow(env, "u1")).results).toHaveLength(1);
  });

  it("removes the user, their events, recordings and D1 rows, and clears the cookies", async () => {
    const bucket = fakeBucket();
    const { env } = makeEnv({ BLOBS: bucket });
    await seed(env, "u1", 3, ["a.webm", "b.webm"]);
    await seed(env, "u2", 2, ["c.webm"]);
    await env.DB.prepare(
      "INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, time_local, weekdays, tz_offset_min, habit, created_at) VALUES (?, ?, 'k', 'a', '09:00', 127, 0, '', 1)",
    )
      .bind("https://push.example/1", "u1")
      .run();
    await env.DB.prepare(
      "INSERT INTO credentials (id, user_id, public_key, counter, created_at) VALUES ('c1', 'u1', ?, 0, 1)",
    )
      .bind(new Uint8Array([1]))
      .run();
    await env.DB.prepare("INSERT INTO recovery_codes (user_id, code_hash) VALUES ('u1', 'h')")
      .bind()
      .run();

    const res = await del(env, "u1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies.every((c) => c.includes("Max-Age=0"))).toBe(true);

    expect((await userRow(env, "u1")).results).toHaveLength(0);
    for (const table of ["credentials", "recovery_codes", "push_subscriptions", "challenges"]) {
      const rows = await env.DB.prepare(`SELECT 1 FROM ${table} WHERE user_id = 'u1'`).bind().all();
      expect(rows.results, table).toHaveLength(0);
    }
    expect(bucket.keys()).toEqual(["u2/c.webm"]);
    // The old token no longer works, and nothing of the other user changed.
    expect(
      (await call("/api/sync/pull?after=0", env, { headers: await bearer("u1") })).status,
    ).toBe(401);
    const other = await call("/api/sync/pull?after=0", env, { headers: await bearer("u2") });
    expect((await other.json<{ events: unknown[] }>()).events).toHaveLength(2);
    expect((await userRow(env, "u2")).results).toHaveLength(1);
  });

  it("deletes more recordings than one R2 page holds", async () => {
    const bucket = fakeBucket(2);
    const { env } = makeEnv({ BLOBS: bucket });
    await seed(env, "u1", 1, ["a.webm", "b.webm", "c.webm", "d.webm", "e.webm"]);
    expect((await del(env, "u1")).status).toBe(200);
    expect(bucket.keys()).toEqual([]);
  });

  it("is retryable: a failure part way leaves the account usable, and a second try finishes", async () => {
    const bucket = fakeBucket();
    let failures = 1;
    const flaky = {
      ...bucket,
      list: bucket.list.bind(bucket),
      delete: (keys: string | string[]) => {
        if (failures-- > 0) return Promise.reject(new Error("r2 down"));
        return bucket.delete(keys);
      },
    } as unknown as R2Bucket;
    const { env } = makeEnv({ BLOBS: flaky });
    await seed(env, "u1", 2, ["a.webm"]);
    const first = await del(env, "u1");
    expect(first.status).toBe(500);
    expect((await userRow(env, "u1")).results).toHaveLength(1);
    expect(
      (await call("/api/sync/pull?after=0", env, { headers: await bearer("u1") })).status,
    ).toBe(200);
    expect((await del(env, "u1")).status).toBe(200);
    expect((await userRow(env, "u1")).results).toHaveLength(0);
    expect(bucket.keys()).toEqual([]);
  });

  it("sweeps again after the D1 delete, so an upload that raced the first sweep is removed", async () => {
    const bucket = fakeBucket();
    let raced = false;
    const racing = {
      ...bucket,
      list: bucket.list.bind(bucket),
      delete: (keys: string | string[]) => {
        const done = bucket.delete(keys);
        if (!raced) {
          // Another device's upload lands right after the first sweep deleted its objects.
          raced = true;
          void bucket.put("u1/late.webm", new Uint8Array([9]));
        }
        return done;
      },
    } as unknown as R2Bucket;
    const { env } = makeEnv({ BLOBS: racing });
    await seed(env, "u1", 1, ["a.webm"]);
    expect((await del(env, "u1")).status).toBe(200);
    expect(bucket.keys()).toEqual([]);
  });

  it("empties the event log before and after the D1 delete, so a late push cannot leave events behind", async () => {
    const real = makeEnv().env.USER_EVENTS;
    const order: string[] = [];
    const watched = {
      idFromName: (name: string) => real.idFromName(name),
      get: (id: DurableObjectId) => {
        const stub = real.get(id);
        return {
          fetch: async (input: string, init?: RequestInit) => {
            if (input.endsWith("/delete")) {
              const rows = await env.DB.prepare("SELECT id FROM users WHERE id = ?")
                .bind("u1")
                .all();
              order.push(
                rows.results.length > 0
                  ? "event log deleted, user still there"
                  : "event log deleted, user gone",
              );
            }
            return stub.fetch(input, init);
          },
        };
      },
    } as unknown as DurableObjectNamespace;
    const { env } = makeEnv({ USER_EVENTS: watched });
    expect((await del(env, "u1")).status).toBe(200);
    expect(order).toEqual(["event log deleted, user still there", "event log deleted, user gone"]);
  });

  it("works for an account with nothing stored", async () => {
    const { env } = makeEnv();
    expect((await del(env, "u3")).status).toBe(200);
    expect((await userRow(env, "u3")).results).toHaveLength(0);
  });
});

describe("GET /api/me/export", () => {
  it("needs a session and only allows GET", async () => {
    const { env } = makeEnv();
    expect((await call("/api/me/export", env)).status).toBe(401);
    const res = await call("/api/me/export", env, { method: "POST", headers: await bearer("u1") });
    expect(res.status).toBe(405);
  });

  it("downloads the account, events, recording list and cue settings as JSON", async () => {
    const { env } = makeEnv();
    await seed(env, "u1", 3, ["a.webm"]);
    await seed(env, "u2", 1, ["other.webm"]);
    await env.DB.prepare(
      "INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, time_local, weekdays, tz_offset_min, habit, created_at) VALUES (?, 'u1', 'SECRETKEY', 'SECRETAUTH', '08:30', 62, 60, 'after coffee', 5)",
    )
      .bind("https://push.example/endpoint-secret")
      .run();
    const res = await exportOf(env, "u1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("clavis-export.json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    const doc = JSON.parse(text) as {
      format: string;
      account: {
        userId: string;
        createdAt: number;
        passkeys: unknown[];
        recoveryCodesLeft: number;
      };
      practiceCues: Record<string, unknown>[];
      events: { serverSeq: number; event: { id: string } }[];
      recordings: { name: string; size: number }[];
    };
    expect(doc.format).toBe("clavis-export-1");
    expect(doc.account).toEqual({ userId: "u1", createdAt: 0, passkeys: [], recoveryCodesLeft: 0 });
    expect(doc.events.map((e) => e.event.id)).toEqual([ulid(1), ulid(2), ulid(3)]);
    expect(doc.recordings).toEqual([{ name: "a.webm", size: 3 }]);
    expect(doc.practiceCues).toEqual([
      { timeLocal: "08:30", weekdays: 62, tzOffsetMin: 60, habit: "after coffee", createdAt: 5 },
    ]);
    // Secrets and other people's data never appear.
    for (const secret of ["SECRETKEY", "SECRETAUTH", "endpoint-secret", "other.webm"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("pages through a log longer than one pull page", async () => {
    const { env } = makeEnv();
    const total = 1200;
    for (let from = 1; from <= total; from += 400) {
      const res = await call("/api/sync/push", env, {
        method: "POST",
        headers: { ...(await bearer("u1")), "content-type": "application/json" },
        body: JSON.stringify({
          events: Array.from({ length: Math.min(400, total - from + 1) }, (_, i) => ev(from + i)),
        }),
      });
      expect(res.status).toBe(200);
    }
    const doc = await (await exportOf(env, "u1")).json<{ events: unknown[] }>();
    expect(doc.events).toHaveLength(total);
  });

  it("an empty account exports valid JSON", async () => {
    const { env } = makeEnv();
    const doc = await (
      await exportOf(env, "u3")
    ).json<{
      events: unknown[];
      recordings: unknown[];
    }>();
    expect(doc.events).toEqual([]);
    expect(doc.recordings).toEqual([]);
  });
});
