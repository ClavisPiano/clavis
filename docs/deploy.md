# Deploy

Clavis runs as one Cloudflare Worker named `clavis` (`apps/worker`). It serves the SvelteKit static build through Workers Static Assets and handles `/api/*` itself. There is no custom domain; it lives on the `workers.dev` subdomain.

## Workers Builds

Deploys run in Cloudflare Workers Builds, connected to this repository from the dashboard (Workers & Pages, clavis, Settings, Build). GitHub Actions only runs CI; it holds no Cloudflare credentials.

| Setting | Value |
| --- | --- |
| Root directory | `/` (the pnpm workspace root) |
| Build command | `pnpm --filter @clavis/web build` |
| Deploy command | `pnpm --filter @clavis/worker run deploy:ci` |
| Non-production branch deploy command | `npx wrangler versions upload --config apps/worker/wrangler.jsonc --var VERSION:$WORKERS_CI_COMMIT_SHA` |
| Production branch | `main` |
| Build variable | `NODE_VERSION=22` if `.nvmrc` is not picked up |

- The Worker name in the dashboard must match `name` in `apps/worker/wrangler.jsonc` (`clavis`), or the build fails.
- The static assets directory comes from `wrangler.jsonc` (`../web/build`, relative to the config file), so no output directory is set in the dashboard.
- `/api/health` reports the deployed commit sha as `version`.
- The `deploy:ci` script (`apps/worker/package.json`) runs `wrangler d1 migrations apply clavis --remote` and then `wrangler deploy --var VERSION:$WORKERS_CI_COMMIT_SHA`, so the exact steps live in the repo and the dashboard only names the script. Migrations run first, so a new migration is live before the code that needs it. The step is a no-op when nothing is pending, and a failed migration stops the deploy. Because the old Worker keeps serving until the deploy finishes, write every migration so the previous code still works against it (add columns and tables, never drop or rename in the same release; remove old columns in a later release). The Workers Builds API token needs D1 edit permission (Workers & Pages, clavis, Settings, Build, API token).
- Every push to `main` deploys, whether or not CI is green. Merge only green PRs. Workers Builds cannot wait for GitHub checks. Gating a deploy on CI means deploying from a GitHub Actions job that runs after CI passes, which needs a Cloudflare API token stored as a repository secret (this repo deliberately holds none today). Until that is decided, protect `main` with the required `check` and `e2e` status checks so only green PRs can be merged.
- Other branches upload a non-production version with a preview URL, shown on the PR by the Cloudflare GitHub app. Preview URLs must be enabled for the Worker (Settings, Domains & Routes, Preview URLs). Preview versions get no production traffic.

## Deploy manually

```sh
pnpm install --frozen-lockfile
pnpm --filter @clavis/web build
pnpm --filter @clavis/worker exec wrangler login   # once
pnpm --filter @clavis/worker deploy
```

Local preview of the full stack: `pnpm --filter @clavis/worker dev` (builds the web app, then runs `wrangler dev`).

## Secrets and Durable Objects

- `SESSION_SECRET` signs session tokens (HMAC-SHA256) for `/api/sync/*`. Never put it in `wrangler.jsonc` or the repo. Generate a long random value and set it once per environment:

  ```sh
  openssl rand -base64 48 | pnpm --filter @clavis/worker exec wrangler secret put SESSION_SECRET
  ```

  Rotating it signs every user out. For local `wrangler dev`, put `SESSION_SECRET=...` in `apps/worker/.dev.vars` (git-ignored).
- Each user's event log is capped at 500,000 events and 256 MiB of stored event JSON (`DEFAULT_LIMITS` in `event-log.ts`, tracked in a `stats` row so a push never scans the log). A push past either answers 403 `quota_exceeded` and stores none of the batch; the client reports a sync error and keeps pulling.
- Each user's events live in a `UserEvents` Durable Object with SQLite storage (binding `USER_EVENTS`). The first deploy applies the `v1` migration in `wrangler.jsonc` (`new_sqlite_classes`). Add new classes or renames as new migration tags, never edit a shipped one.
- Sync API: `POST /api/sync/push` (`{ events }`, max 500 per batch, 2 MiB body) and `GET /api/sync/pull?after=N&limit=M` (default 500, max 1000). Auth is `Authorization: Bearer <token>` or the `__Host-clavis_session` cookie (the older `clavis_session` name is still read). A cookie-authenticated push also needs an `Origin` equal to `EXPECTED_ORIGIN`; bearer callers do not. The server accepts any well-formed envelope, including unknown future event types, and rejects malformed events of types it knows.

## Passkey auth (D1)

Passkeys (WebAuthn) are the only login method. Accounts, credentials, recovery code hashes and short-lived challenges live in a D1 database bound as `DB`. Session tokens are the HMAC tokens above, delivered in the `__Host-clavis_session` cookie (HttpOnly, Secure, SameSite=Lax, Path=/, no Domain, 30 days). Sign out also clears the pre-prefix `clavis_session` cookie.

One-time setup:

```sh
# 1. Create the database and copy the printed database_id into wrangler.jsonc (d1_databases[0]).
pnpm --filter @clavis/worker exec wrangler d1 create clavis

# 2. Apply migrations to the remote database (repeat after adding a migration file).
pnpm --filter @clavis/worker exec wrangler d1 migrations apply clavis --remote

# Local dev database (used by `wrangler dev`):
pnpm --filter @clavis/worker exec wrangler d1 migrations apply clavis --local
```

- Set `RP_ID` (bare host, for example `clavis.me.workers.dev`) and `EXPECTED_ORIGIN` (`https://clavis.me.workers.dev`) in `vars` in `wrangler.jsonc`. They are set to the production host (`clavis.clavis-7fc.workers.dev`); for `wrangler dev`, override them in `apps/worker/.dev.vars` with `RP_ID=localhost` and `EXPECTED_ORIGIN=http://localhost:8787`. A passkey is bound to `RP_ID`, so changing it later orphans existing passkeys; pick the final host first (moving to a custom domain means a new RP id, so users re-register or use recovery codes).
- `SESSION_SECRET` (above) must be set before any login works.
- Migrations are numbered files in `apps/worker/migrations/`. Never edit a shipped one; add the next number.
- `@simplewebauthn/server` runs on Workers without `nodejs_compat`: it only uses WebCrypto (`globalThis.crypto`) and pure JS dependencies, and imports no Node built-ins. No compatibility flag is set. If a future upgrade starts importing `node:` modules, `wrangler deploy --dry-run` will fail and `nodejs_compat` must be added.
- Endpoints (all JSON; every POST needs `content-type: application/json` and an `Origin` header equal to `EXPECTED_ORIGIN`): `POST /api/auth/register/options|verify`, `login/options|verify`, `recovery`, `passkeys/options|verify` (signed in), `logout`, `logout/all` (signed in) and `GET /api/me`. The `options` endpoints return `{ challengeId, options }`; pass `challengeId` back with the browser response to the matching `verify` endpoint. Challenges are single use and expire after 5 minutes.
- Rate limiting: the Workers Rate Limiting bindings in `wrangler.jsonc` (`ratelimits`) limit the unauthenticated auth POSTs per client IP (`CF-Connecting-IP`). `AUTH_LIMITER` allows 20 requests per 60 s across `register/*` and `login/*`; `AUTH_RECOVERY_LIMITER` allows 5 per 60 s on `recovery`. Over the limit the Worker answers 429 `{ "error": "rate_limited" }` with `retry-after: 60`, and the app shows "Too many attempts". Signed-in routes (`passkeys/*`, `logout`) and `/api/me` are not limited. Counts are kept per Cloudflare location and are approximate, which is enough to slow guessing and abuse. If the limiter errors, requests are allowed (fail open). Nothing to create in the dashboard: the bindings deploy with the Worker. To change the limits, edit `simple.limit` (periods can only be 10 or 60 s).

### Session revocation

Each user row has a `session_epoch` (migration `0003_session_epoch.sql`). Tokens carry the epoch they were issued under (`ep`, 0 when absent), and every authenticated request checks it with one indexed D1 read, which also rejects tokens for users that no longer exist. `POST /api/auth/logout/all` bumps the epoch, ending every session on every device. Using a recovery code bumps it too, because a recovery usually means a lost or stolen passkey. Plain `logout` still only clears this device's cookie. A key id in the token for `SESSION_SECRET` rotation is not implemented yet.

### Passkeys and recovery codes

Signed-in routes (all `POST` except the list; migration `0006_credential_label.sql` adds the optional `credentials.label`):

- `GET /api/auth/passkeys` lists `{ id, label, createdAt, lastUsedAt }` for the user. The public key and counter are never returned.
- `POST /api/auth/passkeys/rename` `{ id, label }` sets the name (trimmed, up to 60 characters; empty clears it). 404 for an unknown or another user's passkey.
- `POST /api/auth/passkeys/remove` `{ id }` deletes a passkey. The delete is refused with 409 `last_credential` when it would leave no passkey and no unused recovery code, in one SQL statement so two requests cannot both pass the check. A removal bumps the session epoch (the person may be removing a stolen device) and returns a fresh cookie, so this device stays signed in and every other session ends.
- `POST /api/auth/recovery/regenerate` replaces every recovery code, used or not, with ten new ones, returned once. It shares the recovery rate limiter.

The Settings screen shows the passkey list, rename and remove (with a confirmation), a warning at three or fewer unused codes, and a "Make new recovery codes" button.

### Registration cap

`register/options` and `register/verify` return 503 `registration_paused` (Retry-After 3600) when `MAX_REGISTRATIONS_PER_HOUR` (100, in `auth/handlers.ts`) accounts were created in the last hour, counted from `users.created_at` (index added by `0005_users_created_at.sql`). It is global, so it bounds a flood spread across many IPs; the per-IP limiters stay as the first line. The cap logs a warning when it trips, and a limiter that errors logs `auth rate limiter failed` and lets the request through. Sign in is never capped. Raising the cap is a code change and a deploy.

## Practice cue (Web Push)

The practice cue (spec 14) is a daily push notification at a time the learner picks. The Worker sends it from a cron trigger (`triggers.crons` is `*/15 * * * *` in `wrangler.jsonc`, so cues normally land within 15 minutes of the chosen time).

- Generate a VAPID key pair once per environment (the private key never goes in the repo):

  ```sh
  node apps/worker/scripts/generate-vapid-keys.mjs
  pnpm --filter @clavis/worker exec wrangler secret put VAPID_PRIVATE_KEY   # paste the private value
  ```

  Put the public value in `vars.VAPID_PUBLIC_KEY` in `wrangler.jsonc` (it is served to browsers at `GET /api/push/key`) and set `vars.VAPID_SUBJECT` to a `mailto:` or `https:` contact for push services. For local `wrangler dev`, put all three in `apps/worker/.dev.vars`. Rotating the pair invalidates every subscription: browsers keep the old key, so the push service rejects sends and those rows are pruned, and learners switch the reminder off and on again to resubscribe. With the public key empty, `/api/push/key` returns 503 and the cron does nothing.
- Apply the `0002_push.sql` migration (`wrangler d1 migrations apply clavis --remote`). It adds `push_subscriptions` (one row per device endpoint, with the cue time, weekday mask, `tz_offset_min`, habit phrase, `last_sent_day` and `last_practised_day`).
- Endpoints (signed in, JSON, `Origin` must equal `EXPECTED_ORIGIN`): `PUT /api/push/subscription`, `DELETE /api/push/subscription` (`{ endpoint }`, only removes the caller's own endpoint), `POST /api/push/practised` (`{ day }`, the learner day, R6, so today's cue is skipped on all of that user's devices). `GET /api/push/key` needs no session.
- A cue is due when the learner-local time (UTC plus the stored offset) is within 30 minutes after the chosen time (`CUE_WINDOW_MIN`, two cron runs), that weekday is selected, nothing was sent for today's learner day (04:00 rollover) and the learner has not been reported as practised. Sending uses VAPID (ES256 JWT) and `aes128gcm` encryption via WebCrypto only (`apps/worker/src/push/webpush.ts`, tested against the RFC 8291 vector). Endpoints answering 404 or 410 are deleted; other failures are retried on the next tick while the cue is still in its window.
- Subscription endpoints must be https URLs on a known push service, because the Worker POSTs to them: `fcm.googleapis.com` (Chromium browsers), `push.services.mozilla.com` (Firefox), `web.push.apple.com` (Safari) and `notify.windows.com`, each including subdomains. No ports or credentials. Anything else is refused with 400, and stored rows outside the list are pruned by the cron without being sent to. When a browser ships a new push service, add its host to `PUSH_SERVICE_HOSTS` in `apps/worker/src/push/endpoint.ts`.
- Each user may hold at most 10 subscriptions (`MAX_SUBSCRIPTIONS_PER_USER`). Subscribing an 11th device replaces that user's oldest one, so turning the reminder on always works on the device in hand.
- The free plan allows 50 subrequests per invocation, so one run sends at most 40 pushes (`MAX_SENDS_PER_RUN`). Cues over the cap are sent by the next run, because a cue stays due for two runs and the longest-overdue cues go first. `last_sent_day` still limits each device to one cue per learner day. Raise the cap on a paid plan, or shard by user. Each run reads only the rows near their cue time (`listNearDue`, an index on `cue_utc_min`, the UTC minute of the day of the cue, added by migration `0004`). Rows written without it (by a Worker deployed before the migration) are given one when they come up. When more cues are due than the cap, the run logs `deferred` (left for the next run) and `dropped` (their window closes first), so a busy time slot shows up in the logs.
- Cue settings are device-local on the client (device meta, not a synced setting): a push subscription belongs to one browser, and the right time and habit differ per device. The Worker holds a copy with each subscription. The client re-sends it when settings are saved and when the Settings page opens, so a changed time zone is picked up.
- iOS delivers web push only to an app installed to the Home Screen (16.4 or later). The Settings page detects standalone mode and explains this otherwise.

## Recordings (R2)

Recordings are stored in an R2 bucket bound as `BLOBS`. Create it once before the first deploy (the deploy fails while the bucket is missing):

```sh
pnpm --filter @clavis/worker exec wrangler r2 bucket create clavis-blobs
```

- `PUT|GET|DELETE /api/blobs/:name`. Auth is the same as sync. `PUT` and `DELETE` also need an `Origin` header equal to `EXPECTED_ORIGIN`. The stored key is always `<userId>/<name>` with the user id from the token. `name` matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` and has no `..`.
- `PUT` accepts `audio/webm`, `audio/ogg`, `audio/mp4`, `audio/wav` and `audio/mpeg`, up to 20 MiB (413 above that, 415 for other types). `GET` returns the stored content type with `cache-control: private`.
- Per-user ceilings: 200 objects and 500 MiB in total (`MAX_USER_BLOBS`, `MAX_USER_BLOB_BYTES`). A `PUT` past either answers 403 `quota_exceeded`; replacing an existing name does not count toward the object count (a larger replacement can still hit the byte ceiling). The checks are not atomic across concurrent uploads, so the ceilings are approximate. The client keeps its own copies under a size cap (200 MB) and uploads oldest first. There is no listing endpoint.

## Finding the workers.dev URL

The deploy log ends with `https://clavis.<your-subdomain>.workers.dev`. It is also shown in the dashboard under Workers & Pages, clavis. The subdomain is chosen once per account under Workers & Pages, Account details.

## Security headers and CSP

- `apps/web/static/_headers` is copied into the build and applied by Workers Static Assets. It sets `frame-ancestors`, nosniff, referrer and permissions policies, and cache rules. It deliberately sets no COOP or COEP (no SharedArrayBuffer).
- The static build has an inline bootstrap script, so the script, style, image and connect policy is generated by SvelteKit (`kit.csp` in `apps/web/vite.config.ts`, hash mode) and emitted as a `<meta>` tag with the script hash. `frame-ancestors` cannot be set from a meta tag, hence the header file. Both policies apply.
- Verovio (notation) needs no CSP change. Its WASM is inlined in the worker chunk and instantiated from memory, which `script-src 'wasm-unsafe-eval'` already allows. The module worker is a same-origin file (`/_app/immutable/workers/verovio.worker-*.js`), covered by `worker-src 'self'`. `blob:` in `worker-src` is not needed for it. The worker is built as ES modules (`worker.format: "es"` in `vite.config.ts`).
- `node scripts/notation-size.mjs` (`pnpm --filter @clavis/web notation-size`) checks the notation chunk size against `apps/web/notation-size-baseline.json` and fails on more than 10% growth. CI runs it after the e2e build. Rewrite the baseline with `--update` when growth is intended.
- API responses get their own headers in `apps/worker/src/index.ts`.
