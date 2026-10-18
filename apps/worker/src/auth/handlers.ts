import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { z } from "zod";
import { nowMs, type Env } from "../env";
import { csrfFailure, json, methodNotAllowed } from "../http";
import { authenticate } from "./guard";
import { createAuthRepo, type AuthRepo, type ChallengeKind } from "./repo";
import { fromBase64Url, signSession, toBase64Url } from "./session";
import { d1Sql } from "./sql";

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const RECOVERY_CODE_COUNT = 10;
const RP_NAME = "Clavis";
const COOKIE_NAME = "clavis_session";
const MAX_AUTH_BODY_BYTES = 64 * 1024;

const randomBytes = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));

/** 128-bit random id, base64url. Used for user ids and challenge ids. */
const randomId = (): string => toBase64Url(randomBytes(16));

const BASE32 = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 symbols, so `byte & 31` is unbiased

/** `XXXX-XXXX-XXXX-XXXX`: 80 bits of entropy. */
function generateRecoveryCode(): string {
  const chars = Array.from(randomBytes(16), (b) => BASE32.charAt(b & 31)).join("");
  return (chars.match(/.{4}/g) ?? []).join("-");
}

const normalizeCode = (code: string): string => code.replaceAll(/[\s-]/g, "").toUpperCase();

async function hashCode(code: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalizeCode(code)),
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function sessionCookie(token: string, maxAge: number): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${String(maxAge)}`;
}

async function withSession(
  env: Env,
  userId: string,
  epoch: number,
  body: unknown,
  status = 200,
): Promise<Response> {
  const exp = Math.floor(nowMs(env) / 1000) + SESSION_TTL_SECONDS;
  const token = await signSession({ sub: userId, exp, ep: epoch }, env.SESSION_SECRET);
  return json(body, status, { "set-cookie": sessionCookie(token, SESSION_TTL_SECONDS) });
}

/** Parse the JSON body against a schema; null on any failure. Empty bodies count as `{}`. */
async function readBody<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<z.output<S> | null> {
  const raw = await request.arrayBuffer();
  if (raw.byteLength > MAX_AUTH_BODY_BYTES) return null;
  let value: unknown = {};
  if (raw.byteLength > 0) {
    try {
      value = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return null;
    }
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const NoBody = z.object({});
const VerifyBody = z.object({
  challengeId: z.string().min(1).max(128),
  response: z.looseObject({ id: z.string().min(1).max(2048) }),
});
const RecoveryBody = z.object({ code: z.string().min(1).max(64) });

const invalidRequest = (): Response => json({ error: "invalid_request" }, 400);
const invalidChallenge = (): Response => json({ error: "invalid_challenge" }, 400);

async function newChallenge(
  repo: AuthRepo,
  env: Env,
  kind: ChallengeKind,
  challenge: string,
  userId: string | null,
): Promise<string> {
  const now = nowMs(env);
  const id = randomId();
  await repo.putChallenge({ id, challenge, kind, userId, expiresAt: now + CHALLENGE_TTL_MS }, now);
  return id;
}

function registrationOptions(
  env: Env,
  userId: string,
  excludeIds: { id: string; transports: string[] }[],
) {
  return generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: env.RP_ID,
    userName: `clavis-${userId.slice(0, 8)}`,
    userDisplayName: RP_NAME,
    // The library types want a plain ArrayBuffer-backed view.
    userID: (fromBase64Url(userId) ?? new TextEncoder().encode(userId)) as Uint8Array<ArrayBuffer>,
    attestationType: "none",
    excludeCredentials: excludeIds,
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
  });
}

async function registerOptions(request: Request, env: Env, repo: AuthRepo): Promise<Response> {
  if ((await readBody(request, NoBody)) === null) return invalidRequest();
  const userId = randomId();
  const options = await registrationOptions(env, userId, []);
  const challengeId = await newChallenge(repo, env, "register", options.challenge, userId);
  return json({ challengeId, options });
}

async function registerVerify(request: Request, env: Env, repo: AuthRepo): Promise<Response> {
  const body = await readBody(request, VerifyBody);
  if (!body) return invalidRequest();
  const stored = await repo.consumeChallenge(body.challengeId, "register", nowMs(env));
  if (!stored?.userId) return invalidChallenge();
  const verification = await verifyRegistration(env, body.response, stored.challenge);
  if (!verification) return json({ error: "verification_failed" }, 400);
  const { credential } = verification;
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  const hashes = await Promise.all(codes.map(hashCode));
  try {
    await repo.createUser(
      stored.userId,
      {
        id: credential.id,
        userId: stored.userId,
        publicKey: credential.publicKey,
        counter: credential.counter,
        transports: credential.transports ?? [],
      },
      hashes,
      nowMs(env),
    );
  } catch {
    // Most likely the credential id is already registered.
    return json({ error: "credential_exists" }, 409);
  }
  return withSession(env, stored.userId, 0, { userId: stored.userId, recoveryCodes: codes });
}

async function verifyRegistration(env: Env, response: unknown, expectedChallenge: string) {
  try {
    const result = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON,
      expectedChallenge,
      expectedOrigin: env.EXPECTED_ORIGIN,
      expectedRPID: env.RP_ID,
      requireUserVerification: false,
    });
    return result.verified ? result.registrationInfo : null;
  } catch {
    return null;
  }
}

async function loginOptions(request: Request, env: Env, repo: AuthRepo): Promise<Response> {
  if ((await readBody(request, NoBody)) === null) return invalidRequest();
  // No allowCredentials: discoverable credentials, the authenticator offers its accounts.
  const options = await generateAuthenticationOptions({
    rpID: env.RP_ID,
    userVerification: "preferred",
  });
  const challengeId = await newChallenge(repo, env, "login", options.challenge, null);
  return json({ challengeId, options });
}

async function loginVerify(request: Request, env: Env, repo: AuthRepo): Promise<Response> {
  const body = await readBody(request, VerifyBody);
  if (!body) return invalidRequest();
  const stored = await repo.consumeChallenge(body.challengeId, "login", nowMs(env));
  if (!stored) return invalidChallenge();
  const credential = await repo.getCredential(body.response.id);
  if (!credential) return json({ error: "verification_failed" }, 401);
  let newCounter: number;
  try {
    const result = await verifyAuthenticationResponse({
      response: body.response as unknown as AuthenticationResponseJSON,
      expectedChallenge: stored.challenge,
      expectedOrigin: env.EXPECTED_ORIGIN,
      expectedRPID: env.RP_ID,
      requireUserVerification: false,
      credential: {
        id: credential.id,
        publicKey: credential.publicKey as Uint8Array<ArrayBuffer>,
        counter: credential.counter,
        transports: credential.transports,
      },
    });
    if (!result.verified) return json({ error: "verification_failed" }, 401);
    newCounter = result.authenticationInfo.newCounter;
  } catch {
    // Includes a counter regression, which signals a cloned authenticator.
    return json({ error: "verification_failed" }, 401);
  }
  await repo.touchCredential(credential.id, newCounter, nowMs(env));
  const epoch = await repo.sessionEpoch(credential.userId);
  if (epoch === null) return json({ error: "verification_failed" }, 401);
  return withSession(env, credential.userId, epoch, { userId: credential.userId });
}

async function recovery(request: Request, env: Env, repo: AuthRepo): Promise<Response> {
  const body = await readBody(request, RecoveryBody);
  if (!body) return invalidRequest();
  const userId = await repo.useRecoveryCode(await hashCode(body.code), nowMs(env));
  if (!userId) return json({ error: "invalid_code" }, 401);
  // A recovery code means the passkey may be lost or stolen: end every other session first.
  const epoch = await repo.bumpSessionEpoch(userId);
  if (epoch === null) return json({ error: "invalid_code" }, 401);
  const left = await repo.recoveryCodesLeft(userId);
  return withSession(env, userId, epoch, { userId, recoveryCodesLeft: left });
}

async function addOptions(request: Request, env: Env, repo: AuthRepo): Promise<Response> {
  const userId = await authenticate(request, env);
  if (userId === null) return json({ error: "unauthorized" }, 401);
  if ((await readBody(request, NoBody)) === null) return invalidRequest();
  const existing = await repo.listCredentials(userId);
  const options = await registrationOptions(
    env,
    userId,
    existing.map((c) => ({ id: c.id, transports: c.transports })),
  );
  const challengeId = await newChallenge(repo, env, "add", options.challenge, userId);
  return json({ challengeId, options });
}

async function addVerify(request: Request, env: Env, repo: AuthRepo): Promise<Response> {
  const userId = await authenticate(request, env);
  if (userId === null) return json({ error: "unauthorized" }, 401);
  const body = await readBody(request, VerifyBody);
  if (!body) return invalidRequest();
  const stored = await repo.consumeChallenge(body.challengeId, "add", nowMs(env));
  if (stored === null) return invalidChallenge();
  if (stored.userId !== userId) return invalidChallenge();
  const verification = await verifyRegistration(env, body.response, stored.challenge);
  if (!verification) return json({ error: "verification_failed" }, 400);
  const { credential } = verification;
  try {
    await repo.addCredential(
      {
        id: credential.id,
        userId,
        publicKey: credential.publicKey,
        counter: credential.counter,
        transports: credential.transports ?? [],
      },
      nowMs(env),
    );
  } catch {
    return json({ error: "credential_exists" }, 409);
  }
  return json({ userId, passkeys: (await repo.listCredentials(userId)).length });
}

function logout(): Response {
  return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
}

/** Sign out everywhere: bump the epoch so every token issued so far stops working. */
async function logoutAll(request: Request, env: Env, repo: AuthRepo): Promise<Response> {
  const userId = await authenticate(request, env);
  if (userId === null) return json({ error: "unauthorized" }, 401);
  if ((await readBody(request, NoBody)) === null) return invalidRequest();
  await repo.bumpSessionEpoch(userId);
  return logout();
}

async function me(request: Request, env: Env, repo: AuthRepo): Promise<Response> {
  const userId = await authenticate(request, env);
  if (userId === null) return json({ error: "unauthorized" }, 401);
  const [passkeys, recoveryCodesLeft] = await Promise.all([
    repo.listCredentials(userId),
    repo.recoveryCodesLeft(userId),
  ]);
  return json({ userId, passkeys: passkeys.length, recoveryCodesLeft });
}

type PostHandler = (request: Request, env: Env, repo: AuthRepo) => Promise<Response>;

const POST_ROUTES: Record<string, PostHandler> = {
  "/api/auth/register/options": registerOptions,
  "/api/auth/register/verify": registerVerify,
  "/api/auth/login/options": loginOptions,
  "/api/auth/login/verify": loginVerify,
  "/api/auth/recovery": recovery,
  "/api/auth/passkeys/options": addOptions,
  "/api/auth/passkeys/verify": addVerify,
  "/api/auth/logout": () => Promise.resolve(logout()),
  "/api/auth/logout/all": logoutAll,
};

/** Seconds a client should wait after a 429; the limiters count over 60 s windows. */
export const RATE_LIMIT_RETRY_AFTER_S = 60;

/** Which limiter guards a route. Signed-in routes (passkeys, logout) are not rate limited. */
function limiterFor(path: string, env: Env): RateLimit | undefined {
  if (path === "/api/auth/recovery") return env.AUTH_RECOVERY_LIMITER;
  if (path.startsWith("/api/auth/register/") || path.startsWith("/api/auth/login/")) {
    return env.AUTH_LIMITER;
  }
  return undefined;
}

/**
 * True when the client is over its limit. Keyed on the client IP. Fails open: if the limiter
 * itself errors, the request goes through, because locking everyone out is worse than a short gap.
 */
async function rateLimited(request: Request, limiter: RateLimit): Promise<boolean> {
  const key = request.headers.get("cf-connecting-ip") ?? "unknown";
  try {
    return !(await limiter.limit({ key })).success;
  } catch (error) {
    console.error("auth rate limiter failed, allowing request", error);
    return false;
  }
}

/** Routes `/api/me` and `/api/auth/*`. */
export async function handleAuth(request: Request, url: URL, env: Env): Promise<Response> {
  const repo = createAuthRepo(d1Sql(env.DB));
  if (url.pathname === "/api/me") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    return me(request, env, repo);
  }
  const handler = POST_ROUTES[url.pathname];
  if (!handler) return json({ error: "not_found" }, 404);
  if (request.method !== "POST") return methodNotAllowed("POST");
  const blocked = csrfFailure(request, env);
  if (blocked) return blocked;
  const limiter = limiterFor(url.pathname, env);
  if (limiter && (await rateLimited(request, limiter))) {
    return json({ error: "rate_limited" }, 429, {
      "retry-after": String(RATE_LIMIT_RETRY_AFTER_S),
    });
  }
  return handler(request, env, repo);
}
