import type { Env } from "./env";

export const API_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
};

export function json(body: unknown, status = 200, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...API_HEADERS, ...extra } });
}

export function methodNotAllowed(allow: string): Response {
  return json({ error: "method_not_allowed" }, 405, { allow });
}

/** CSRF defence: JSON content type (not form-submittable) plus an exact Origin match. */
export function csrfFailure(request: Request, env: Env): Response | null {
  const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") return json({ error: "unsupported_media_type" }, 415);
  if (request.headers.get("origin") !== env.EXPECTED_ORIGIN)
    return json({ error: "forbidden" }, 403);
  return null;
}
