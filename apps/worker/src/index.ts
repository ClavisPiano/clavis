export interface Env {
  /** Workers Static Assets binding serving the web build. */
  ASSETS: Fetcher;
  /** Build id (commit SHA in CI), "dev" locally. Set via `vars` or `--var VERSION:<sha>`. */
  VERSION: string;
  // Later milestones add bindings here (per-user Durable Object, D1, R2).
}

const API_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: API_HEADERS });
}

function handleApi(request: Request, url: URL, env: Env): Response {
  if (url.pathname === "/api/health") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(JSON.stringify({ error: "method_not_allowed" }), {
        status: 405,
        headers: { ...API_HEADERS, allow: "GET, HEAD" },
      });
    }
    return json({ ok: true, version: env.VERSION });
  }
  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return handleApi(request, url, env);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
