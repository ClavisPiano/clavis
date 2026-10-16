import type { BlobMeta, BlobRecord } from "@clavis/store";

/*
 * Recording upload queue (T4.5). Plain TypeScript with injected store, uploader and delay so it
 * tests without a network or timers.
 *
 * - Uploads blobs that are not yet uploaded, oldest first, one at a time.
 * - Network failures, 5xx, 408 and 429 are retried with backoff (`maxAttempts` per blob per run);
 *   when they run out the run ends as "error" and the next sync trigger tries again.
 * - 401 stops the run at once ("signedOut"); nothing is marked uploaded.
 * - Other 4xx (bad name, type or size) skip that blob for this run and carry on.
 * - Single-flight: `run()` during a run schedules one follow-up pass and returns the same promise,
 *   and a key is never uploaded twice at the same time.
 */

export class BlobAuthError extends Error {
  constructor() {
    super("not signed in");
    this.name = "BlobAuthError";
  }
}

/** The server refused this blob for good (4xx other than 401, 408, 429). */
export class BlobRejectedError extends Error {
  constructor(readonly status: number) {
    super(`upload rejected with status ${String(status)}`);
    this.name = "BlobRejectedError";
  }
}

export type UploadOutcome = "ok" | "signedOut" | "error";

export interface UploadRunResult {
  outcome: UploadOutcome;
  uploaded: number;
  /** Blobs the server rejected for good during this run. */
  rejected: number;
  detail?: string;
}

export interface UploadQueueDeps {
  store: {
    list(): Promise<BlobMeta[]>;
    get(key: string): Promise<BlobRecord | undefined>;
    markUploaded(key: string): Promise<void>;
  };
  /** Throws `BlobAuthError`, `BlobRejectedError`, or any other error (retryable). */
  upload: (record: BlobRecord) => Promise<void>;
  delay?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  baseDelayMs?: number;
}

export interface UploadQueue {
  run(): Promise<UploadRunResult>;
}

export function createUploadQueue(deps: UploadQueueDeps): UploadQueue {
  const delay = deps.delay ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxAttempts = deps.maxAttempts ?? 3;
  const baseDelayMs = deps.baseDelayMs ?? 1000;
  const inFlight = new Set<string>();
  let running: Promise<UploadRunResult> | undefined;
  let rerun = false;

  async function pass(skip: Set<string>): Promise<UploadRunResult> {
    const result: UploadRunResult = { outcome: "ok", uploaded: 0, rejected: 0 };
    const pending = (await deps.store.list()).filter((m) => !m.uploaded && !skip.has(m.key));
    for (const meta of pending) {
      if (inFlight.has(meta.key)) continue;
      inFlight.add(meta.key);
      try {
        const record = await deps.store.get(meta.key);
        // Evicted or already uploaded since the listing.
        if (!record || record.uploaded) continue;
        let attempt = 0;
        for (;;) {
          attempt++;
          try {
            await deps.upload(record);
            await deps.store.markUploaded(record.key);
            result.uploaded++;
            break;
          } catch (error) {
            if (error instanceof BlobAuthError) return { ...result, outcome: "signedOut" };
            if (error instanceof BlobRejectedError) {
              result.rejected++;
              skip.add(record.key);
              break;
            }
            if (attempt >= maxAttempts) {
              return {
                ...result,
                outcome: "error",
                detail: error instanceof Error ? error.message : String(error),
              };
            }
            await delay(baseDelayMs * 2 ** (attempt - 1));
          }
        }
      } finally {
        inFlight.delete(meta.key);
      }
    }
    return result;
  }

  async function loop(): Promise<UploadRunResult> {
    const skip = new Set<string>();
    let total: UploadRunResult = { outcome: "ok", uploaded: 0, rejected: 0 };
    do {
      rerun = false;
      const r = await pass(skip);
      total = {
        ...r,
        uploaded: total.uploaded + r.uploaded,
        rejected: total.rejected + r.rejected,
      };
      if (r.outcome !== "ok") break;
    } while (rerun as boolean);
    return total;
  }

  return {
    run() {
      if (running) {
        rerun = true;
        return running;
      }
      running = loop().finally(() => {
        running = undefined;
      });
      return running;
    },
  };
}

/**
 * Same-origin uploader for `PUT /api/blobs/:name`. The session cookie travels via
 * `credentials: "include"`, and the browser adds the Origin header the server checks.
 */
export function createFetchUploader(
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
  base = "/api/blobs",
): (record: BlobRecord) => Promise<void> {
  return async (record) => {
    const res = await fetchFn(`${base}/${encodeURIComponent(record.key)}`, {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": record.contentType },
      body: record.blob,
    });
    if (res.ok) return;
    if (res.status === 401) throw new BlobAuthError();
    const retryable = res.status === 408 || res.status === 429;
    if (res.status >= 400 && res.status < 500 && !retryable) {
      throw new BlobRejectedError(res.status);
    }
    throw new Error(`blob server error ${String(res.status)}`);
  };
}
