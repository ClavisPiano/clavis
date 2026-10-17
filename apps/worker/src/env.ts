export interface Env {
  /** Workers Static Assets binding serving the web build. */
  ASSETS: Fetcher;
  /** Build id (commit SHA in CI), "dev" locally. Set via `vars` or `--var VERSION:<sha>`. */
  VERSION: string;
  /** Per-user event store (one `UserEvents` Durable Object per user). */
  USER_EVENTS: DurableObjectNamespace;
  /** HMAC key for session tokens. Set with `wrangler secret put SESSION_SECRET`. */
  SESSION_SECRET: string;
  /** Accounts, passkey credentials, recovery codes and challenges. */
  DB: D1Database;
  /** WebAuthn relying party id: the bare host name, for example `clavis.me.workers.dev`. */
  RP_ID: string;
  /** Exact origin the web app is served from, for example `https://clavis.me.workers.dev`. */
  EXPECTED_ORIGIN: string;
  /** VAPID public key (base64url, 65 byte uncompressed P-256 point), served at `/api/push/key`. */
  VAPID_PUBLIC_KEY?: string;
  /** VAPID private scalar (base64url, 32 bytes). Set with `wrangler secret put VAPID_PRIVATE_KEY`. */
  VAPID_PRIVATE_KEY?: string;
  /** VAPID contact claim, a `mailto:` or `https:` URL. */
  VAPID_SUBJECT?: string;
  /** R2 bucket for recordings, keyed `${userId}/${name}`. */
  BLOBS: R2Bucket;
  /** Test seam for the clock (unix ms). Never set in production. */
  now?: () => number;
}

export const nowMs = (env: Env): number => (env.now ? env.now() : Date.now());
