import { MAX_BLOB_BYTES, baseContentType, isAllowedBlobType, isValidBlobName } from "@clavis/core";
import { authenticate } from "./auth/guard";
import type { Env } from "./env";
import { API_HEADERS, json, methodNotAllowed, readLimited } from "./http";

/*
 * Recording storage in R2 (T4.5). The object key is always `${userId}/${name}` with the user id
 * taken from the session token, so one user can never address another user's objects. `name` is a
 * single path segment from a strict pattern; it never contains a slash or "..".
 */

const PREFIX = "/api/blobs/";

/** Decode and validate the `:name` segment; null when it is not acceptable. */
export function parseBlobName(pathname: string): string | null {
  if (!pathname.startsWith(PREFIX)) return null;
  let name: string;
  try {
    name = decodeURIComponent(pathname.slice(PREFIX.length));
  } catch {
    return null;
  }
  return isValidBlobName(name) ? name : null;
}

/** CSRF defence for state-changing blob calls: the content type is audio, so Origin is the check. */
const originOk = (request: Request, env: Env): boolean =>
  request.headers.get("origin") === env.EXPECTED_ORIGIN;

export async function handleBlob(request: Request, url: URL, env: Env): Promise<Response> {
  const { method } = request;
  if (method !== "PUT" && method !== "GET" && method !== "DELETE") {
    return methodNotAllowed("GET, PUT, DELETE");
  }
  const userId = await authenticate(request, env);
  if (userId === null) return json({ error: "unauthorized" }, 401);
  if (method !== "GET" && !originOk(request, env)) return json({ error: "forbidden" }, 403);
  const name = parseBlobName(url.pathname);
  if (name === null) return json({ error: "invalid_name" }, 400);
  const key = `${userId}/${name}`;

  try {
    if (method === "GET") {
      const object = await env.BLOBS.get(key);
      if (!object) return json({ error: "not_found" }, 404);
      return new Response(object.body, {
        status: 200,
        headers: {
          ...API_HEADERS,
          "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
          "cache-control": "private",
          "content-length": String(object.size),
        },
      });
    }
    if (method === "DELETE") {
      await env.BLOBS.delete(key);
      return new Response(null, { status: 204, headers: API_HEADERS });
    }
    const raw = request.headers.get("content-type") ?? "";
    const type = baseContentType(raw);
    if (!isAllowedBlobType(raw)) {
      return json({ error: "unsupported_media_type" }, 415);
    }
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (!Number.isFinite(declared) || declared < 0) return json({ error: "invalid_request" }, 400);
    if (declared > MAX_BLOB_BYTES) return json({ error: "payload_too_large" }, 413);
    const bytes = await readLimited(request, MAX_BLOB_BYTES);
    if (bytes === null) return json({ error: "payload_too_large" }, 413);
    if (bytes.byteLength === 0) return json({ error: "invalid_request" }, 400);
    await env.BLOBS.put(key, bytes, { httpMetadata: { contentType: type } });
    return json({ ok: true, size: bytes.byteLength }, 200);
  } catch {
    return json({ error: "internal" }, 500);
  }
}
