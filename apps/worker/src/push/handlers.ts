import { daysBetween, learnerDay } from "@clavis/core";
import { z } from "zod";
import { authenticate } from "../auth/guard";
import { fromBase64Url } from "../auth/session";
import { d1Sql } from "../auth/sql";
import { nowMs, type Env } from "../env";
import { csrfFailure, json, methodNotAllowed, readLimited } from "../http";
import { weekdaysToMask } from "./due";
import { isAcceptableEndpoint } from "./endpoint";
import { createPushRepo } from "./repo";

const MAX_BODY_BYTES = 16 * 1024;
export const MAX_HABIT_CHARS = 60;

const Endpoint = z.string().max(2048).refine(isAcceptableEndpoint);
const Key = (bytes: number) =>
  z
    .string()
    .max(256)
    .refine((v) => fromBase64Url(v)?.length === bytes);

const SubscribeBody = z.object({
  subscription: z.object({
    endpoint: Endpoint,
    keys: z.object({ p256dh: Key(65), auth: Key(16) }),
  }),
  cue: z.object({
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    weekdays: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .refine((d) => new Set(d).size === d.length),
    habit: z
      .string()
      .max(MAX_HABIT_CHARS)
      .transform((h) => h.trim()),
  }),
  tzOffsetMin: z.number().int().min(-840).max(840),
});
const UnsubscribeBody = z.object({ endpoint: z.string().max(2048) });
const PractisedBody = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

async function readBody<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<z.output<S> | null> {
  const raw = await readLimited(request, MAX_BODY_BYTES);
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null;
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const invalidRequest = (): Response => json({ error: "invalid_request" }, 400);

const EndpointOnly = z.object({ subscription: z.object({ endpoint: z.string().max(2048) }) });

/** The host of a well-formed https endpoint that the allowlist refused, else undefined. */
async function rejectedEndpointHost(request: Request): Promise<string | undefined> {
  const body = await readBody(request, EndpointOnly);
  if (!body || isAcceptableEndpoint(body.subscription.endpoint)) return undefined;
  try {
    const url = new URL(body.subscription.endpoint);
    return url.protocol === "https:" ? url.hostname : undefined;
  } catch {
    return undefined;
  }
}

/** True for a real `YYYY-MM-DD` date: `Date.parse` alone would accept 2026-02-31 on some runtimes. */
export function isCalendarDay(day: string): boolean {
  const ms = Date.parse(`${day}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === day;
}

/** Routes `/api/push/*`. */
export async function handlePush(request: Request, url: URL, env: Env): Promise<Response> {
  if (url.pathname === "/api/push/key") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    if (!env.VAPID_PUBLIC_KEY) return json({ error: "not_configured" }, 503);
    return json({ publicKey: env.VAPID_PUBLIC_KEY });
  }
  const isSubscription = url.pathname === "/api/push/subscription";
  if (!isSubscription && url.pathname !== "/api/push/practised") {
    return json({ error: "not_found" }, 404);
  }
  const allowed = isSubscription ? ["PUT", "DELETE"] : ["POST"];
  if (!allowed.includes(request.method)) return methodNotAllowed(allowed.join(", "));
  const blocked = csrfFailure(request, env);
  if (blocked) return blocked;
  const userId = await authenticate(request, env);
  if (userId === null) return json({ error: "unauthorized" }, 401);
  const repo = createPushRepo(d1Sql(env.DB));

  if (isSubscription && request.method === "PUT") {
    const copy = request.clone();
    const body = await readBody(request, SubscribeBody);
    if (!body) {
      // A browser moving to a push service not in the allowlist shows up here, so log the host
      // (never the full endpoint: its path is a bearer capability for that device).
      const host = await rejectedEndpointHost(copy);
      if (host) console.warn(`push subscribe: endpoint host not allowed: ${host}`);
      return invalidRequest();
    }
    await repo.upsert(
      {
        endpoint: body.subscription.endpoint,
        userId,
        p256dh: body.subscription.keys.p256dh,
        auth: body.subscription.keys.auth,
        timeLocal: body.cue.time,
        weekdays: weekdaysToMask(body.cue.weekdays),
        tzOffsetMin: body.tzOffsetMin,
        habit: body.cue.habit,
      },
      nowMs(env),
    );
    return json({ ok: true });
  }
  if (isSubscription) {
    const body = await readBody(request, UnsubscribeBody);
    if (!body) return invalidRequest();
    // Same answer whether the endpoint is unknown or someone else's, so ids cannot be probed.
    await repo.deleteOwned(userId, body.endpoint);
    return json({ ok: true });
  }
  const body = await readBody(request, PractisedBody);
  if (!body || !isCalendarDay(body.day)) return invalidRequest();
  // Any real time zone is within a day of UTC, so a day far from now is a bad clock or a probe.
  if (Math.abs(daysBetween(learnerDay(nowMs(env), 0), body.day)) > 2) return invalidRequest();
  await repo.markPractised(userId, body.day);
  return json({ ok: true });
}
