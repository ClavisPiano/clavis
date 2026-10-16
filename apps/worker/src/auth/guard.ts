import { nowMs, type Env } from "../env";
import { extractToken, verifySession } from "./session";

/** Resolve the session user id, or null when the token is missing, invalid or expired. */
export async function authenticate(request: Request, env: Env): Promise<string | null> {
  const token = extractToken(request);
  if (!token) return null;
  const claims = await verifySession(token, env.SESSION_SECRET, nowMs(env));
  return claims?.sub ?? null;
}
