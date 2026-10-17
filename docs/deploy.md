# Deploy

Clavis runs as one Cloudflare Worker named `clavis` (`apps/worker`). It serves the SvelteKit static build through Workers Static Assets and handles `/api/*` itself. There is no custom domain; it lives on the `workers.dev` subdomain.

## Workers Builds

Deploys run in Cloudflare Workers Builds, connected to this repository from the dashboard (Workers & Pages, clavis, Settings, Build). GitHub Actions only runs CI; it holds no Cloudflare credentials.

| Setting | Value |
| --- | --- |
| Root directory | `/` (the pnpm workspace root) |
| Build command | `pnpm --filter @clavis/web build` |
| Deploy command | `npx wrangler deploy --config apps/worker/wrangler.jsonc --var VERSION:$WORKERS_CI_COMMIT_SHA` |
| Non-production branch deploy command | `npx wrangler versions upload --config apps/worker/wrangler.jsonc --var VERSION:$WORKERS_CI_COMMIT_SHA` |
| Production branch | `main` |
| Build variable | `NODE_VERSION=22` if `.nvmrc` is not picked up |

- The Worker name in the dashboard must match `name` in `apps/worker/wrangler.jsonc` (`clavis`), or the build fails.
- The static assets directory comes from `wrangler.jsonc` (`../web/build`, relative to the config file), so no output directory is set in the dashboard.
- `/api/health` reports the deployed commit sha as `version`.
- Every push to `main` deploys, whether or not CI is green. Merge only green PRs.
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
- Each user's events live in a `UserEvents` Durable Object with SQLite storage (binding `USER_EVENTS`). The first deploy applies the `v1` migration in `wrangler.jsonc` (`new_sqlite_classes`). Add new classes or renames as new migration tags, never edit a shipped one.
- Sync API: `POST /api/sync/push` (`{ events }`, max 500 per batch, 2 MiB body) and `GET /api/sync/pull?after=N&limit=M` (default 500, max 1000). Auth is `Authorization: Bearer <token>` or the `clavis_session` cookie. The server accepts any well-formed envelope, including unknown future event types, and rejects malformed events of types it knows.

## Passkey auth (D1)

Passkeys (WebAuthn) are the only login method. Accounts, credentials, recovery code hashes and short-lived challenges live in a D1 database bound as `DB`. Session tokens are the HMAC tokens above, delivered in the `clavis_session` cookie (HttpOnly, Secure, SameSite=Lax, 30 days).

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
- Endpoints (all JSON; every POST needs `content-type: application/json` and an `Origin` header equal to `EXPECTED_ORIGIN`): `POST /api/auth/register/options|verify`, `login/options|verify`, `recovery`, `passkeys/options|verify` (signed in), `logout`, and `GET /api/me`. The `options` endpoints return `{ challengeId, options }`; pass `challengeId` back with the browser response to the matching `verify` endpoint. Challenges are single use and expire after 5 minutes.
- Follow-up: there is no rate limiting yet. Add a Cloudflare rate limiting rule (or the Workers rate limit binding) on `/api/auth/*`, in particular `/api/auth/recovery`, before opening sign-ups widely.

## Recordings (R2)

Recordings are stored in an R2 bucket bound as `BLOBS`. Create it once before the first deploy (the deploy fails while the bucket is missing):

```sh
pnpm --filter @clavis/worker exec wrangler r2 bucket create clavis-blobs
```

- `PUT|GET|DELETE /api/blobs/:name`. Auth is the same as sync. `PUT` and `DELETE` also need an `Origin` header equal to `EXPECTED_ORIGIN`. The stored key is always `<userId>/<name>` with the user id from the token. `name` matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` and has no `..`.
- `PUT` accepts `audio/webm`, `audio/ogg`, `audio/mp4`, `audio/wav` and `audio/mpeg`, up to 20 MiB (413 above that, 415 for other types). `GET` returns the stored content type with `cache-control: private`.
- There is no server-side listing or quota yet. The client keeps its own copies under a size cap (200 MB) and uploads oldest first.

## Finding the workers.dev URL

The deploy log ends with `https://clavis.<your-subdomain>.workers.dev`. It is also shown in the dashboard under Workers & Pages, clavis. The subdomain is chosen once per account under Workers & Pages, Account details.

## Security headers and CSP

- `apps/web/static/_headers` is copied into the build and applied by Workers Static Assets. It sets `frame-ancestors`, nosniff, referrer and permissions policies, and cache rules. It deliberately sets no COOP or COEP (no SharedArrayBuffer).
- The static build has an inline bootstrap script, so the script, style, image and connect policy is generated by SvelteKit (`kit.csp` in `apps/web/vite.config.ts`, hash mode) and emitted as a `<meta>` tag with the script hash. `frame-ancestors` cannot be set from a meta tag, hence the header file. Both policies apply.
- Verovio (notation) needs no CSP change. Its WASM is inlined in the worker chunk and instantiated from memory, which `script-src 'wasm-unsafe-eval'` already allows. The module worker is a same-origin file (`/_app/immutable/workers/verovio.worker-*.js`), covered by `worker-src 'self'`. `blob:` in `worker-src` is not needed for it. The worker is built as ES modules (`worker.format: "es"` in `vite.config.ts`).
- `node scripts/notation-size.mjs` (`pnpm --filter @clavis/web notation-size`) checks the notation chunk size against `apps/web/notation-size-baseline.json` and fails on more than 10% growth. CI runs it after the e2e build. Rewrite the baseline with `--update` when growth is intended.
- API responses get their own headers in `apps/worker/src/index.ts`.
