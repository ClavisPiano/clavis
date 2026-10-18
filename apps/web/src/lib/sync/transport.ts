import {
  PullResponse,
  PushResponse,
  SyncAuthError,
  SyncRejectedError,
  type SyncTransport,
} from "@clavis/core";

/*
 * Same-origin fetch transport for /api/sync/*. The session cookie travels via
 * `credentials: "include"`. 401 becomes `SyncAuthError`, other 4xx become `SyncRejectedError`,
 * and 5xx, network failures and malformed responses throw plain errors (treated as offline).
 */
export function createFetchTransport(
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
  base = "/api/sync",
  /** Called with each response's `Date` header, to learn how far this device's clock is off (T8.4). */
  onServerDate?: (dateHeader: string | null) => void,
): SyncTransport {
  async function call(url: string, init: RequestInit): Promise<unknown> {
    const res = await fetchFn(url, { ...init, credentials: "include" });
    try {
      onServerDate?.(res.headers.get("date"));
    } catch {
      // Learning the clock offset is a side benefit: it must never turn a good response into a failed sync.
    }
    if (res.status === 401) throw new SyncAuthError("not signed in");
    // 408 and 429 are "try again later", not a verdict on the batch.
    const retryable = res.status === 408 || res.status === 429;
    if (res.status >= 400 && res.status < 500 && !retryable) {
      throw new SyncRejectedError(res.status);
    }
    if (!res.ok) throw new Error(`sync server error ${String(res.status)}`);
    try {
      return (await res.json()) as unknown;
    } catch {
      throw new Error("sync response was not JSON");
    }
  }
  return {
    async push(request) {
      const body = await call(`${base}/push`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      const parsed = PushResponse.safeParse(body);
      if (!parsed.success) throw new Error("unexpected push response");
      return parsed.data;
    },
    async pull({ after, limit }) {
      const q = new URLSearchParams({ after: String(after) });
      if (limit !== undefined) q.set("limit", String(limit));
      const body = await call(`${base}/pull?${q.toString()}`, { method: "GET" });
      const parsed = PullResponse.safeParse(body);
      if (!parsed.success) throw new Error("unexpected pull response");
      return parsed.data;
    },
  };
}
