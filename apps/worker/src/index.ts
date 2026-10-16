import { DEFAULT_PULL_LIMIT, PullRequest, PushRequest } from "@clavis/core";
import { extractToken, verifySession } from "./auth/session";

export { UserEvents } from "./user-events";

/** Largest accepted push body. 500 events at a few KB each fits well inside this. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface Env {
  /** Workers Static Assets binding serving the web build. */
  ASSETS: Fetcher;
  /** Build id (commit SHA in CI), "dev" locally. Set via `vars` or `--var VERSION:<sha>`. */
  VERSION: string;
  /** Per-user event store (one `UserEvents` Durable Object per user). */
  USER_EVENTS: DurableObjectNamespace;
  /** HMAC key for session tokens. Set with `wrangler secret put SESSION_SECRET`. */
  SESSION_SECRET: string;
  // Later milestones add bindings here (D1, R2).
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

function methodNotAllowed(allow: string): Response {
  return new Response(JSON.stringify({ error: "method_not_allowed" }), {
    status: 405,
    headers: { ...API_HEADERS, allow },
  });
}

const unauthorized = (): Response => json({ error: "unauthorized" }, 401);

/** Resolve the session user id, or null when the token is missing, invalid or expired. */
async function authenticate(request: Request, env: Env): Promise<string | null> {
  const token = extractToken(request);
  if (!token) return null;
  const claims = await verifySession(token, env.SESSION_SECRET, Date.now());
  return claims?.sub ?? null;
}

/** The user id comes from the token, never from the payload (R7). */
function userStub(env: Env, userId: string): DurableObjectStub {
  return env.USER_EVENTS.get(env.USER_EVENTS.idFromName(userId));
}

/** Forward to the user's DO; a throw there becomes a JSON 500 with the API headers. */
async function relay(call: () => Promise<Response>): Promise<Response> {
  try {
    const res = await call();
    return new Response(await res.text(), { status: res.status, headers: API_HEADERS });
  } catch {
    return json({ error: "internal" }, 500);
  }
}

async function handlePush(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const userId = await authenticate(request, env);
  if (userId === null) return unauthorized();
  // A cross-site form can send the cookie with text/plain but not with application/json.
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(type)) {
    return json({ error: "unsupported_media_type" }, 415);
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);
  const raw = await request.arrayBuffer();
  if (raw.byteLength > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
  const parsed = PushRequest.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_request" }, 400);
  return relay(() =>
    userStub(env, userId).fetch("https://user-events/push", {
      method: "POST",
      body: JSON.stringify(parsed.data),
    }),
  );
}

async function handlePull(request: Request, url: URL, env: Env): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const userId = await authenticate(request, env);
  if (userId === null) return unauthorized();
  const parsed = PullRequest.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return json({ error: "invalid_request" }, 400);
  const query = new URLSearchParams({
    after: String(parsed.data.after),
    limit: String(parsed.data.limit ?? DEFAULT_PULL_LIMIT),
  });
  return relay(() => userStub(env, userId).fetch(`https://user-events/pull?${query.toString()}`));
}

async function handleApi(request: Request, url: URL, env: Env): Promise<Response> {
  if (url.pathname === "/api/health") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed("GET, HEAD");
    }
    return json({ ok: true, version: env.VERSION });
  }
  if (url.pathname === "/api/sync/push") return handlePush(request, env);
  if (url.pathname === "/api/sync/pull") return handlePull(request, url, env);
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
