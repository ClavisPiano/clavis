import { nowMs, type Env } from "../env";
import { createAuthRepo } from "./repo";
import { extractToken, verifySession, type SessionClaims } from "./session";
import { d1Sql } from "./sql";

/**
 * Resolve the session claims, or null when the token is missing, invalid or expired, the user no
 * longer exists, or the token was issued under an older session epoch (signed out everywhere).
 * Costs one indexed D1 read per authenticated request.
 */
export async function authenticateSession(
  request: Request,
  env: Env,
): Promise<SessionClaims | null> {
  const token = extractToken(request);
  if (!token) return null;
  const claims = await verifySession(token, env.SESSION_SECRET, nowMs(env));
  if (!claims) return null;
  const epoch = await createAuthRepo(d1Sql(env.DB)).sessionEpoch(claims.sub);
  return epoch !== null && epoch === (claims.ep ?? 0) ? claims : null;
}

/** Resolve the session user id, or null (see `authenticateSession`). */
export async function authenticate(request: Request, env: Env): Promise<string | null> {
  return (await authenticateSession(request, env))?.sub ?? null;
}
