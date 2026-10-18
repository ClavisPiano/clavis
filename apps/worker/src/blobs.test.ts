import { describe, expect, it } from "vitest";
import { signSession } from "./auth/session";
import { MAX_BLOB_BYTES } from "@clavis/core";
import { MAX_USER_BLOBS, MAX_USER_BLOB_BYTES } from "./blobs";
import worker, { type Env } from "./index";
import { ORIGIN, fakeBucket, makeEnv } from "./test-support";

const call = (path: string, env: Env, init?: RequestInit) =>
  worker.fetch(new Request(`${ORIGIN}${path}`, init), env);

const token = (sub: string) =>
  signSession({ sub, exp: Math.floor(Date.now() / 1000) + 3600 }, "test-secret-not-real");

const auth = async (sub: string, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${await token(sub)}`,
  ...extra,
});

const put = async (
  env: Env,
  sub: string,
  name: string,
  body: BodyInit = new Uint8Array([1, 2, 3]),
  headers: Record<string, string> = { "content-type": "audio/webm", origin: ORIGIN },
) => call(`/api/blobs/${name}`, env, { method: "PUT", headers: await auth(sub, headers), body });

const get = async (env: Env, sub: string, name: string) =>
  call(`/api/blobs/${name}`, env, { headers: await auth(sub) });

function setup() {
  const bucket = fakeBucket();
  const { env } = makeEnv({ BLOBS: bucket });
  return { env, bucket };
}

describe("blob routes", () => {
  it("requires auth on every method", async () => {
    const { env } = setup();
    for (const method of ["PUT", "GET", "DELETE"]) {
      const res = await call("/api/blobs/a.webm", env, {
        method,
        headers: { "content-type": "audio/webm", origin: ORIGIN },
        ...(method === "PUT" ? { body: new Uint8Array([1]) } : {}),
      });
      expect(res.status).toBe(401);
    }
  });

  it("round-trips bytes and content type, with private caching", async () => {
    const { env } = setup();
    const res = await put(env, "u1", "take-1.webm", new Uint8Array([9, 8, 7]), {
      "content-type": "audio/webm; codecs=opus",
      origin: ORIGIN,
    });
    expect(res.status).toBe(200);
    const got = await get(env, "u1", "take-1.webm");
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("audio/webm");
    expect(got.headers.get("cache-control")).toBe("private");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect([...new Uint8Array(await got.arrayBuffer())]).toEqual([9, 8, 7]);
  });

  it("prefixes keys with the token user, so users cannot read each other's blobs", async () => {
    const { env, bucket } = setup();
    expect((await put(env, "u1", "secret.webm")).status).toBe(200);
    expect(bucket.keys()).toEqual(["u1/secret.webm"]);
    expect((await get(env, "u2", "secret.webm")).status).toBe(404);
    expect((await get(env, "u1", "secret.webm")).status).toBe(200);
    // Bob deleting the same name touches only his own (absent) object.
    const del = await call("/api/blobs/secret.webm", env, {
      method: "DELETE",
      headers: await auth("u2", { origin: ORIGIN }),
    });
    expect(del.status).toBe(204);
    expect(bucket.keys()).toEqual(["u1/secret.webm"]);
  });

  it.each([
    ["encoded traversal", "%2e%2e%2fx"],
    ["encoded slash", "a%2Fb"],
    ["nested path", "a/b"],
    ["empty", ""],
    ["dotdot inside", "a..b"],
    ["leading dot", ".hidden"],
    ["too long", "a".repeat(129)],
    ["space", "a%20b"],
    ["bad escape", "%zz"],
  ])("rejects bad name: %s", async (_label, name) => {
    const { env, bucket } = setup();
    const res = await put(env, "u1", name);
    expect(res.status).toBe(400);
    expect((await get(env, "u1", name)).status).toBe(400);
    expect(bucket.keys()).toEqual([]);
  });

  it("accepts a 128 character name", async () => {
    const { env } = setup();
    expect((await put(env, "u1", "a".repeat(128))).status).toBe(200);
  });

  it("rejects disallowed content types with 415", async () => {
    const { env } = setup();
    for (const type of ["text/html", "application/json", "image/png", ""]) {
      const res = await put(env, "u1", "x.webm", new Uint8Array([1]), {
        ...(type ? { "content-type": type } : {}),
        origin: ORIGIN,
      });
      expect(res.status).toBe(415);
    }
  });

  it.each(["audio/webm", "audio/ogg", "audio/mp4", "audio/wav", "audio/mpeg"])(
    "accepts %s",
    async (type) => {
      const { env } = setup();
      const res = await put(env, "u1", "x.bin", new Uint8Array([1]), {
        "content-type": type,
        origin: ORIGIN,
      });
      expect(res.status).toBe(200);
    },
  );

  it("rejects oversized bodies by declared and by actual size", async () => {
    const { env, bucket } = setup();
    const big = new Uint8Array(MAX_BLOB_BYTES + 1);
    const declared = await put(env, "u1", "big.webm", big);
    expect(declared.status).toBe(413);
    // No content-length: a stream is only measured as it is read.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_BLOB_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const req = new Request(`${ORIGIN}/api/blobs/s.webm`, {
      method: "PUT",
      headers: await auth("u1", { "content-type": "audio/webm", origin: ORIGIN }),
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect((await worker.fetch(req, env)).status).toBe(413);
    // A lying content-length does not help either.
    const lying = await put(env, "u1", "l.webm", big, {
      "content-type": "audio/webm",
      origin: ORIGIN,
      "content-length": "10",
    });
    expect([413, 400]).toContain(lying.status);
    expect(bucket.keys()).toEqual([]);
  });

  it("rejects a non-numeric content-length with 400", async () => {
    const { env, bucket } = setup();
    // undici computes content-length from the body, so hand the Worker a header it cannot parse.
    const req = new Request(`${ORIGIN}/api/blobs/n.webm`, {
      method: "PUT",
      headers: await auth("u1", { "content-type": "audio/webm", origin: ORIGIN }),
      body: new Uint8Array([1, 2, 3]),
    });
    const headers = new Headers(req.headers);
    headers.set("content-length", "abc");
    const res = await worker.fetch(
      new Proxy(req, {
        get: (target, prop): unknown =>
          prop === "headers" ? headers : (Reflect.get(target, prop, target) as unknown),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(bucket.keys()).toEqual([]);
  });

  it("accepts a body exactly at the limit", async () => {
    const { env } = setup();
    expect((await put(env, "u1", "max.webm", new Uint8Array(MAX_BLOB_BYTES))).status).toBe(200);
  });

  it("rejects empty bodies", async () => {
    const { env } = setup();
    expect((await put(env, "u1", "e.webm", new Uint8Array(0))).status).toBe(400);
  });

  it("rejects a wrong or missing Origin on PUT and DELETE", async () => {
    const { env, bucket } = setup();
    for (const origin of ["https://evil.example", undefined]) {
      const headers: Record<string, string> = { "content-type": "audio/webm" };
      if (origin) headers.origin = origin;
      expect((await put(env, "u1", "x.webm", new Uint8Array([1]), headers)).status).toBe(403);
      const del = await call("/api/blobs/x.webm", env, {
        method: "DELETE",
        headers: await auth("u1", origin ? { origin } : {}),
      });
      expect(del.status).toBe(403);
    }
    expect(bucket.keys()).toEqual([]);
  });

  it("DELETE removes the object, and is idempotent", async () => {
    const { env, bucket } = setup();
    await put(env, "u1", "x.webm");
    const authHeaders = await auth("u1", { origin: ORIGIN });
    const del = () => call("/api/blobs/x.webm", env, { method: "DELETE", headers: authHeaders });
    expect((await del()).status).toBe(204);
    expect(bucket.keys()).toEqual([]);
    expect((await get(env, "u1", "x.webm")).status).toBe(404);
    expect((await del()).status).toBe(204);
  });

  it("returns 405 for other methods and 500 when the bucket throws", async () => {
    const { env } = setup();
    const res = await call("/api/blobs/x.webm", env, { method: "POST" });
    expect(res.status).toBe(405);
    const broken = {
      ...env,
      BLOBS: { get: () => Promise.reject(new Error("r2 down")) } as unknown as R2Bucket,
    };
    expect((await get(broken, "u1", "x.webm")).status).toBe(500);
  });
});

describe("blob quotas", () => {
  it("refuses a new blob past the per-user count, but still allows replacing one", async () => {
    const { env } = setup();
    for (let i = 0; i < MAX_USER_BLOBS; i++) {
      expect((await put(env, "u1", `take-${String(i)}.webm`)).status).toBe(200);
    }
    const over = await put(env, "u1", "one-too-many.webm");
    expect(over.status).toBe(403);
    expect(await over.json()).toEqual({ error: "quota_exceeded" });
    expect((await put(env, "u1", "take-0.webm")).status).toBe(200);
    // Another user is unaffected.
    expect((await put(env, "u2", "mine.webm")).status).toBe(200);
  });

  it("counts every page of the R2 listing, not just the first", async () => {
    // 200 objects over pages of 50: a check that stopped after one page would let a 201st through.
    const bucket = fakeBucket(50);
    const { env } = makeEnv({ BLOBS: bucket });
    for (let i = 0; i < MAX_USER_BLOBS; i++) {
      expect((await put(env, "u1", `take-${String(i)}.webm`)).status).toBe(200);
    }
    expect((await put(env, "u1", "one-too-many.webm")).status).toBe(403);
    expect(bucket.keys().filter((k) => k.startsWith("u1/"))).toHaveLength(MAX_USER_BLOBS);
  });

  it("refuses a blob that would pass the byte ceiling, and allows replacing the big one", async () => {
    const bucket = fakeBucket();
    // Report one huge existing object instead of uploading 500 MB.
    const listing = (size: number) => ({
      ...bucket,
      put: bucket.put.bind(bucket),
      get: bucket.get.bind(bucket),
      delete: bucket.delete.bind(bucket),
      list: () => Promise.resolve({ objects: [{ key: "u1/big.webm", size }], truncated: false }),
    });
    const nearly = makeEnv({
      BLOBS: listing(MAX_USER_BLOB_BYTES - 1) as unknown as R2Bucket,
    }).env;
    // One byte more is exactly the ceiling; two bytes pass it.
    expect((await put(nearly, "u1", "ok.webm", new Uint8Array([1]))).status).toBe(200);
    const over = await put(nearly, "u1", "over.webm", new Uint8Array([1, 2]));
    expect(over.status).toBe(403);
    expect(await over.json()).toEqual({ error: "quota_exceeded" });
    // Replacing the big object frees its bytes, so a small one fits in its place.
    expect((await put(nearly, "u1", "big.webm", new Uint8Array([1, 2, 3]))).status).toBe(200);
  });
});
