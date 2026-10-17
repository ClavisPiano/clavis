/*
 * Shared contract for recording blobs (T4.5), used by the worker (validation) and the client
 * (key and type checks before queueing an upload). A blob key is one path segment; the server
 * prefixes it with the user id.
 */

export const MAX_BLOB_BYTES = 20 * 1024 * 1024;
export const BLOB_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const BLOB_CONTENT_TYPES: readonly string[] = [
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/wav",
  "audio/mpeg",
];

export const isValidBlobName = (name: string): boolean =>
  BLOB_NAME_PATTERN.test(name) && !name.includes("..");

/** Media type without parameters, lowercased (`audio/webm; codecs=opus` becomes `audio/webm`). */
export const baseContentType = (type: string): string =>
  (type.split(";")[0] ?? "").trim().toLowerCase();

export const isAllowedBlobType = (type: string): boolean =>
  BLOB_CONTENT_TYPES.includes(baseContentType(type));
