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
