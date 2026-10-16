/**
 * Session tokens: `base64url(json{sub,exp}).base64url(hmac)`, HMAC-SHA256 over the first part.
 * `sub` is the user id, `exp` is a unix time in seconds. T4.2 issues these after passkey login.
 */

export interface SessionClaims {
  sub: string;
  /** Expiry as unix seconds. */
  exp: number;
}

const encoder = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Returns null for anything that is not unpadded base64url. */
export function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const padded =
    text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4);
  try {
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

export async function signSession(claims: SessionClaims, secret: string): Promise<string> {
  const payload = toBase64Url(encoder.encode(JSON.stringify({ sub: claims.sub, exp: claims.exp })));
  const sig = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, "sign"),
    encoder.encode(payload),
  );
  return `${payload}.${toBase64Url(new Uint8Array(sig))}`;
}

/**
 * Verify signature (constant time, via `crypto.subtle.verify`) and expiry.
 * `nowMs` is injected so callers and tests control the clock. Never throws.
 */
export async function verifySession(
  token: string,
  secret: string,
  nowMs: number,
): Promise<SessionClaims | null> {
  if (!secret) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts as [string, string];
  const sigBytes = fromBase64Url(sig);
  if (!sigBytes) return null;
  try {
    const ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret, "verify"),
      sigBytes,
      encoder.encode(payload),
    );
    if (!ok) return null;
    const bytes = fromBase64Url(payload);
    if (!bytes) return null;
    const claims: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof claims !== "object" || claims === null) return null;
    const { sub, exp } = claims as Record<string, unknown>;
    if (typeof sub !== "string" || sub === "" || typeof exp !== "number" || !Number.isFinite(exp)) {
      return null;
    }
    if (exp * 1000 <= nowMs) return null;
    return { sub, exp };
  } catch {
    return null;
  }
}

const COOKIE_NAME = "clavis_session";

/** Token from `Authorization: Bearer` or the `clavis_session` cookie, or null. */
export function extractToken(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (auth) {
    const m = /^Bearer\s+(\S+)$/i.exec(auth);
    if (m?.[1]) return m[1];
  }
  const cookie = request.headers.get("cookie");
  if (cookie) {
    for (const part of cookie.split(";")) {
      const eq = part.indexOf("=");
      if (eq > 0 && part.slice(0, eq).trim() === COOKIE_NAME) return part.slice(eq + 1).trim();
    }
  }
  return null;
}
