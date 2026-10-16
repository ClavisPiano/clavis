import { DEFAULT_PULL_LIMIT, PullRequest, PushRequest } from "@clavis/core";
import { authenticate } from "./auth/guard";
import { handleAuth } from "./auth/handlers";
import type { Env } from "./env";
import { API_HEADERS, json, methodNotAllowed } from "./http";
import { handlePush as handlePushApi } from "./push/handlers";
import { runPracticeCues } from "./push/scheduled";

export { UserEvents } from "./user-events";
export type { Env } from "./env";

/** Largest accepted push body. 500 events at a few KB each fits well inside this. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

const unauthorized = (): Response => json({ error: "unauthorized" }, 401);

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
  if (url.pathname === "/api/me" || url.pathname.startsWith("/api/auth/")) {
    return handleAuth(request, url, env);
  }
  if (url.pathname.startsWith("/api/push/")) return handlePushApi(request, url, env);
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
  /** Cron trigger (every 15 minutes): send the practice cues that are due. */
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(
      runPracticeCues(env, { nowMs: controller.scheduledTime }).then(
        (r) => {
          console.log(
            `practice cue: due=${String(r.due)} sent=${String(r.sent)} pruned=${String(r.pruned)} failed=${String(r.failed)}`,
          );
        },
        (e: unknown) => {
          console.error("practice cue run failed", e);
        },
      ),
    );
  },
} satisfies ExportedHandler<Env>;
