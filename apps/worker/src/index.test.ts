import { describe, expect, it } from "vitest";
import worker, { type Env } from "./index";

function makeEnv(version = "abc123"): { env: Env; seen: string[] } {
  const seen: string[] = [];
  const ASSETS = {
    fetch: (input: Request | string | URL) => {
      const req = input instanceof Request ? input : new Request(input);
      seen.push(new URL(req.url).pathname);
      return Promise.resolve(new Response("asset", { status: 200 }));
    },
  };
  // The fake only implements the part of Fetcher the worker uses.
  return { env: { ASSETS: ASSETS as unknown as Fetcher, VERSION: version }, seen };
}

const call = (path: string, env: Env, init?: RequestInit) =>
  worker.fetch(new Request(`https://clavis.example${path}`, init), env);

describe("worker router", () => {
  it("GET /api/health returns ok and the version", async () => {
    const { env, seen } = makeEnv("sha-1");
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
