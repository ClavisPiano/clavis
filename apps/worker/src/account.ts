import { DEFAULT_PULL_LIMIT } from "@clavis/core";
import { authenticate } from "./auth/guard";
import { createAuthRepo } from "./auth/repo";
import { COOKIE_NAME, LEGACY_COOKIE_NAME } from "./auth/session";
import { d1Sql } from "./auth/sql";
import { nowMs, type Env } from "./env";
import { API_HEADERS, json, methodNotAllowed } from "./http";
import { createPushRepo } from "./push/repo";

/*
 * Account deletion and data export (T8.8). Both act only on the user in the session token.
 *
 * Deletion removes the recordings (R2), the event log (the user's Durable Object) and then the D1
 * rows. D1 goes last and is one atomic batch: if an earlier step fails the account still exists,
 * the session still works and the person can simply try again. Every step is safe to repeat.
 */

const ME = "/api/me";
const EXPORT = "/api/me/export";

/** R2 returns at most 1000 keys per list and takes up to 1000 per delete. */
const R2_BATCH = 1000;
/** A user holds at most a few hundred recordings; this only stops a runaway loop. */
const MAX_DELETE_ROUNDS = 100;

const userStub = (env: Env, userId: string): DurableObjectStub =>
  env.USER_EVENTS.get(env.USER_EVENTS.idFromName(userId));

const expiredCookies = (): string[] => [
  `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
  `${LEGACY_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
];

/** Delete every recording the user has. Lists again from the start after each delete. */
async function deleteRecordings(env: Env, userId: string): Promise<void> {
  for (let round = 0; round < MAX_DELETE_ROUNDS; round++) {
    const page = await env.BLOBS.list({ prefix: `${userId}/`, limit: R2_BATCH });
    if (page.objects.length === 0) return;
    await env.BLOBS.delete(page.objects.map((o) => o.key));
    if (!page.truncated) return;
  }
  throw new Error("too many recordings to delete in one request");
}

async function deleteAccount(request: Request, env: Env): Promise<Response> {
  const userId = await authenticate(request, env);
  if (userId === null) return json({ error: "unauthorized" }, 401);
  // A cross-site request carries the cookie too, and this one cannot be undone: exact Origin only.
  if (request.headers.get("origin") !== env.EXPECTED_ORIGIN) {
    return json({ error: "forbidden" }, 403);
  }
  try {
    await deleteRecordings(env, userId);
    const res = await userStub(env, userId).fetch("https://user-events/delete", { method: "POST" });
    if (!res.ok) throw new Error(`event log delete failed (${String(res.status)})`);
    await createAuthRepo(d1Sql(env.DB)).deleteUser(userId);
  } catch (error) {
    console.error("account deletion failed", error);
    return json({ error: "internal" }, 500);
  }
  const headers = new Headers(API_HEADERS);
  for (const cookie of expiredCookies()) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

interface Pulled {
  events: unknown[];
  lastSeq: number;
  hasMore: boolean;
}

/** Everything about the account as JSON text, in pieces so a large log never sits in memory. */
async function* exportChunks(env: Env, userId: string): AsyncGenerator<string> {
  const repo = createAuthRepo(d1Sql(env.DB));
  const [createdAt, passkeys, recoveryCodesLeft, cues] = await Promise.all([
    repo.userCreatedAt(userId),
    repo.listPasskeys(userId),
    repo.recoveryCodesLeft(userId),
    createPushRepo(d1Sql(env.DB)).listCues(userId),
  ]);
  const account = { userId, createdAt, passkeys, recoveryCodesLeft };
  yield `{"format":"clavis-export-1","exportedAt":${String(nowMs(env))},"account":${JSON.stringify(account)},"practiceCues":${JSON.stringify(cues)},"events":[`;

  let after = 0;
  let first = true;
  for (;;) {
    const query = new URLSearchParams({ after: String(after), limit: String(DEFAULT_PULL_LIMIT) });
    const res = await userStub(env, userId).fetch(`https://user-events/pull?${query.toString()}`);
    if (!res.ok) throw new Error(`event log read failed (${String(res.status)})`);
    const page = await res.json<Pulled>();
    for (const entry of page.events) {
      yield (first ? "" : ",") + JSON.stringify(entry);
      first = false;
    }
    if (!page.hasMore || page.lastSeq === after) break;
    after = page.lastSeq;
  }

  yield '],"recordings":[';
  let cursor: string | undefined;
  first = true;
  do {
    const page = await env.BLOBS.list({
      prefix: `${userId}/`,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const object of page.objects) {
      const name = object.key.slice(userId.length + 1);
      yield (first ? "" : ",") + JSON.stringify({ name, size: object.size });
      first = false;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  yield "]}";
}

/** Stream the account as one JSON download. A failure part way errors the stream, so the file is invalid, never silently short. */
async function exportAccount(request: Request, env: Env): Promise<Response> {
  const userId = await authenticate(request, env);
  if (userId === null) return json({ error: "unauthorized" }, 401);
  const chunks = exportChunks(env, userId);
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await chunks.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      } catch (error) {
        console.error("account export failed", error);
        controller.error(error);
      }
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      ...API_HEADERS,
      "content-disposition": 'attachment; filename="clavis-export.json"',
    },
  });
}

/** Routes `DELETE /api/me` and `GET /api/me/export`. */
export function handleAccount(request: Request, url: URL, env: Env): Promise<Response> {
  if (url.pathname === EXPORT) {
    return request.method === "GET"
      ? exportAccount(request, env)
      : Promise.resolve(methodNotAllowed("GET"));
  }
  return deleteAccount(request, env);
}

export const isAccountRoute = (pathname: string, method: string): boolean =>
  pathname === EXPORT || (pathname === ME && method === "DELETE");
