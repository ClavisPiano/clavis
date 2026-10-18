import { describe, expect, it } from "vitest";
import { signSession, toBase64Url } from "./auth/session";
import worker, { MAX_BODY_BYTES, type Env } from "./index";
import { SECRET, makeEnv } from "./test-support";

const call = (path: string, env: Env, init?: RequestInit) =>
  worker.fetch(new Request(`https://clavis.example${path}`, init), env);

describe("worker router", () => {
  it("GET /api/health returns ok and the version", async () => {
    const { env, seen } = makeEnv({ VERSION: "sha-1" });
    const res = await call("/api/health", env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: "sha-1" });
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(seen).toEqual([]);
  });

  it("adds security headers to API responses", async () => {
    const { env } = makeEnv();
    const res = await call("/api/health", env);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("rejects non-GET methods on /api/health with 405", async () => {
    const { env } = makeEnv();
    const res = await call("/api/health", env, { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });

  it.each(["/api/nope", "/api/health/extra", "/api", "/api/"])(
    "returns 404 JSON for unknown API path %s",
    async (path) => {
      const { env, seen } = makeEnv();
      const res = await call(path, env);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(seen).toEqual([]);
    },
  );

  it.each(["/", "/settings", "/_app/immutable/entry/start.js", "/apiary"])(
    "delegates %s to the assets binding",
    async (path) => {
      const { env, seen } = makeEnv();
      const res = await call(path, env);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("asset");
      expect(seen).toEqual([path]);
    },
  );
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

const future = () => Math.floor(Date.now() / 1000) + 3600;
const tokenFor = (sub: string, secret = SECRET, exp = future()) =>
  signSession({ sub, exp }, secret);
const bearer = async (sub: string) => ({
  authorization: `Bearer ${await tokenFor(sub)}`,
  "content-type": "application/json",
});

const push = async (env: Env, sub: string, events: unknown[]) =>
  call("/api/sync/push", env, {
    method: "POST",
    headers: await bearer(sub),
    body: JSON.stringify({ events }),
  });
const pull = async (env: Env, sub: string, query: string) =>
  call(`/api/sync/pull?${query}`, env, { headers: await bearer(sub) });

describe("sync routes", () => {
  it("push then pull round-trips, with security headers", async () => {
    const { env } = makeEnv();
    const res = await push(env, "u1", [ev(1), ev(2)]);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.json()).toEqual({ accepted: 2, duplicates: 0, lastSeq: 2 });
    const pulled = await pull(env, "u1", "after=0");
    expect(pulled.status).toBe(200);
    const body = await pulled.json<{
      events: { serverSeq: number; event: unknown }[];
      lastSeq: number;
      hasMore: boolean;
    }>();
    expect(body.events.map((e) => e.event)).toEqual([ev(1), ev(2)]);
    expect(body).toMatchObject({ lastSeq: 2, hasMore: false });
  });

  it("rejects a push that is not application/json with 415 (CSRF)", async () => {
    const { env } = makeEnv();
    for (const type of ["text/plain", "application/x-www-form-urlencoded", ""]) {
      const res = await call("/api/sync/push", env, {
        method: "POST",
        headers: { cookie: `__Host-clavis_session=${await tokenFor("u1")}`, "content-type": type },
        body: JSON.stringify({ events: [ev(1)] }),
      });
      expect(res.status).toBe(415);
    }
    expect(await (await pull(env, "u1", "after=0")).json()).toMatchObject({ events: [] });
  });

  it("turns a Durable Object failure into a JSON 500", async () => {
    const failing = {
      idFromName: (name: string) => name,
      get: () => ({ fetch: () => Promise.reject(new Error("storage")) }),
    } as unknown as DurableObjectNamespace;
    const { env } = makeEnv({ USER_EVENTS: failing });
    const res = await pull(env, "u1", "after=0");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal" });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("accepts the token from the session cookie", async () => {
    const { env } = makeEnv();
    const res = await call("/api/sync/pull?after=0", env, {
      headers: { cookie: `__Host-clavis_session=${await tokenFor("u1")}` },
    });
    expect(res.status).toBe(200);
  });

  it("rejects a token for a user that does not exist or whose epoch moved on", async () => {
    const { env } = makeEnv();
    const ghost = await call("/api/sync/pull?after=0", env, { headers: await bearer("nobody") });
    expect(ghost.status).toBe(401);
    const stale = await signSession({ sub: "u1", exp: future(), ep: 0 }, SECRET);
    await env.DB.prepare("UPDATE users SET session_epoch = 1 WHERE id = ?").bind("u1").run();
    const res = await call("/api/sync/pull?after=0", env, {
      headers: { authorization: `Bearer ${stale}` },
    });
    expect(res.status).toBe(401);
    const fresh = await signSession({ sub: "u1", exp: future(), ep: 1 }, SECRET);
    const ok = await call("/api/sync/pull?after=0", env, {
      headers: { authorization: `Bearer ${fresh}` },
    });
    expect(ok.status).toBe(200);
  });

  it("requires the exact Origin on a cookie-authenticated push, not a bearer one", async () => {
    const { env } = makeEnv();
    const cookie = `__Host-clavis_session=${await tokenFor("u1")}`;
    const send = (headers: Record<string, string>) =>
      call("/api/sync/push", env, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ events: [ev(1)] }),
      });
    expect((await send({ cookie })).status).toBe(403);
    expect((await send({ cookie, origin: "https://evil.example" })).status).toBe(403);
    expect((await send({ cookie, origin: env.EXPECTED_ORIGIN })).status).toBe(200);
    expect((await send(await bearer("u1"))).status).toBe(200);
  });

  it("duplicate push is idempotent", async () => {
    const { env } = makeEnv();
    await push(env, "u1", [ev(1), ev(2)]);
    const again = await push(env, "u1", [ev(1), ev(2)]);
    expect(await again.json()).toEqual({ accepted: 0, duplicates: 2, lastSeq: 2 });
    const body = await (await pull(env, "u1", "after=0")).json<{ events: unknown[] }>();
    expect(body.events).toHaveLength(2);
  });

  it("concurrent pushes get distinct, strictly increasing seqs", async () => {
    const { env } = makeEnv();
    const batches = Array.from({ length: 10 }, (_, i) => [ev(i * 3), ev(i * 3 + 1), ev(i * 3 + 2)]);
    const results = await Promise.all(batches.map((b) => push(env, "u1", b)));
    for (const r of results) expect(r.status).toBe(200);
    const body = await (
      await pull(env, "u1", "after=0")
    ).json<{
      events: { serverSeq: number }[];
    }>();
    const seqs = body.events.map((e) => e.serverSeq);
    expect(seqs).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  });

  it("paginates", async () => {
    const { env } = makeEnv();
    await push(env, "u1", [1, 2, 3, 4, 5].map(ev));
    const p1 = await (
      await pull(env, "u1", "after=0&limit=2")
    ).json<{
      events: unknown[];
      lastSeq: number;
      hasMore: boolean;
    }>();
    expect(p1).toMatchObject({ lastSeq: 2, hasMore: true });
    expect(p1.events).toHaveLength(2);
    const p2 = await (
      await pull(env, "u1", `after=${String(p1.lastSeq)}&limit=10`)
    ).json<{
      events: unknown[];
      hasMore: boolean;
    }>();
    expect(p2.events).toHaveLength(3);
    expect(p2.hasMore).toBe(false);
  });

  it("isolates users", async () => {
    const { env } = makeEnv();
    await push(env, "u1", [ev(1), ev(2)]);
    expect(await (await push(env, "u2", [ev(1)])).json()).toEqual({
      accepted: 1,
      duplicates: 0,
      lastSeq: 1,
    });
    const u2 = await (await pull(env, "u2", "after=0")).json<{ events: unknown[] }>();
    expect(u2.events).toHaveLength(1);
  });

  it("stores unknown future event types", async () => {
    const { env } = makeEnv();
    const future1 = { ...ev(1), type: "future.thing", v: 7, extra: { a: 1 } };
    expect((await push(env, "u1", [future1])).status).toBe(200);
    const body = await (
      await pull(env, "u1", "after=0")
    ).json<{
      events: { event: unknown }[];
    }>();
    expect(body.events[0]?.event).toEqual(future1);
  });

  it.each([
    ["malformed known event", { ...ev(1), platform: 5 }],
    ["bad id", { ...ev(1), id: "nope" }],
    ["userId present", { ...ev(1), userId: "u9" }],
    ["not an object", 7],
  ])("rejects %s with 400 and stores nothing", async (_name, bad) => {
    const { env } = makeEnv();
    const res = await push(env, "u1", [ev(1), bad]);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
    const body = await (await pull(env, "u1", "after=0")).json<{ events: unknown[] }>();
    expect(body.events).toEqual([]);
  });

  it("rejects bad JSON, wrong shape and oversized batches with 400", async () => {
    const { env } = makeEnv();
    const headers = await bearer("u1");
    for (const body of ["{nope", "{}", JSON.stringify({ events: "x" })]) {
      const res = await call("/api/sync/push", env, { method: "POST", headers, body });
      expect(res.status).toBe(400);
    }
    const res = await push(
      env,
      "u1",
      Array.from({ length: 501 }, (_, i) => ev(i)),
    );
    expect(res.status).toBe(400);
  });

  it("rejects invalid pull queries with 400", async () => {
    const { env } = makeEnv();
    for (const q of ["", "after=-1", "after=x", "after=0&limit=0", "after=0&limit=1001"]) {
      expect((await pull(env, "u1", q)).status).toBe(400);
    }
  });

  it("returns 413 for oversized bodies", async () => {
    const { env } = makeEnv();
    const body = JSON.stringify({ events: [], pad: "x".repeat(MAX_BODY_BYTES) });
    const res = await call("/api/sync/push", env, {
      method: "POST",
      headers: await bearer("u1"),
      body,
    });
    expect(res.status).toBe(413);
  });

  it("returns 413 for a streamed body without content-length that exceeds the cap", async () => {
    const { env } = makeEnv();
    const chunk = new TextEncoder().encode("x".repeat(512 * 1024));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ >= 10) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const res = await call("/api/sync/push", env, {
      method: "POST",
      headers: await bearer("u1"),
      body,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(sent).toBeLessThan(10);
  });

  it("returns 405 with allow for wrong methods", async () => {
    const { env } = makeEnv();
    const a = await call("/api/sync/push", env);
    expect(a.status).toBe(405);
    expect(a.headers.get("allow")).toBe("POST");
    const b = await call("/api/sync/pull?after=0", env, { method: "POST" });
    expect(b.status).toBe(405);
    expect(b.headers.get("allow")).toBe("GET");
  });

  describe("auth", () => {
    const attempts = async (): Promise<[string, Record<string, string>][]> => {
      const good = await tokenFor("u1");
      const [payload, sig] = good.split(".") as [string, string];
      const forgedPayload = toBase64Url(
        new TextEncoder().encode(JSON.stringify({ sub: "u2", exp: future() })),
      );
      return [
        ["missing", {}],
        ["garbage", { authorization: "Bearer nope" }],
        ["expired", { authorization: `Bearer ${await tokenFor("u1", SECRET, 1)}` }],
        ["wrong secret", { authorization: `Bearer ${await tokenFor("u1", "other")}` }],
        ["tampered payload", { authorization: `Bearer ${forgedPayload}.${sig}` }],
        ["tampered signature", { authorization: `Bearer ${payload}.${sig.slice(0, -3)}AAA` }],
      ];
    };

    it("returns 401 JSON on push and pull", async () => {
      const { env } = makeEnv();
      for (const [, headers] of await attempts()) {
        const a = await call("/api/sync/push", env, {
          method: "POST",
          headers,
          body: JSON.stringify({ events: [ev(1)] }),
        });
        expect(a.status).toBe(401);
        expect(await a.json()).toEqual({ error: "unauthorized" });
        expect(a.headers.get("x-content-type-options")).toBe("nosniff");
        const b = await call("/api/sync/pull?after=0", env, { headers });
        expect(b.status).toBe(401);
      }
      const ok = await (await pull(env, "u1", "after=0")).json<{ events: unknown[] }>();
      expect(ok.events).toEqual([]);
    });

    it("returns 401 when the secret is not configured", async () => {
      const { env } = makeEnv({ SESSION_SECRET: "" });
      const res = await call("/api/sync/pull?after=0", env, { headers: await bearer("u1") });
      expect(res.status).toBe(401);
    });
  });
});
