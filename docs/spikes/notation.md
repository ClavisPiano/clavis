# T3.2 notation spike: Verovio or a custom SVG staff renderer

Issue #68. Diagnostic page: `/dev/notation` (source in `apps/web/src/routes/dev/notation`). Question: is Verovio (WASM) fast and small enough for READ items on the floor device, or do we build `SvgStaffRenderer` (one staff, notes and simple rhythms) behind the same `NotationRenderer` interface and keep Verovio only for M7 imports?

## What was built

- `verovio` 6.3.0 (LGPL-3.0-or-later, see `docs/licences.md`) pinned in `apps/web`.
- `apps/web/src/lib/notation/verovio.worker.ts`: a module worker. It imports `verovio/wasm` (the Emscripten module, WASM inlined as base64) and `verovio/esm` (the toolkit wrapper), initialises once, then answers `render` requests (MEI in, SVG out) with `performance.now()` timings. Verovio ships no types, so `verovio.d.ts` declares the few members used.
- `apps/web/src/lib/notation/spike-mei.ts`: hand-written MEI for the four T3.1 fixtures. **Spike data only**, replaced by `toMei(score)` from T3.3.
- `/dev/notation`: one button per fixture, plus Benchmark.
- `apps/web/scripts/notation-size.mjs` and `apps/web/notation-size-baseline.json`: size check, see below.
- `apps/web/e2e/notation.spec.ts`: renders each fixture, checks the note ids appear in the SVG, runs the benchmark, attaches the JSON (`notation-benchmark.json`) and logs it.

## What is measured

| Metric | How |
|---|---|
| Size | After `pnpm --filter @clavis/web build`, the notation output (`_app/immutable/workers/verovio.worker-*.js`; the WASM is inside it, there is no separate `.wasm`) is read as emitted: raw, gzip level 9 and brotli quality 11 with Node zlib |
| Cold init | Time on the page from `new Worker(...)` to the `ready` message. This includes fetching the worker script, decoding the base64 WASM, compiling and instantiating it, and creating and configuring the toolkit. On a second Benchmark tap the script comes from the HTTP cache, which is the "cold init from cache" number the decision uses |
| Worker init split | Inside the worker: `moduleMs` (create the Emscripten module) and `toolkitMs` (construct and set options) |
| First render | Round trip (main thread) of the first `render` after ready |
| Warm render | 50 renders cycling through the four fixtures: round trip p50, p95, max (main thread view), and in-worker `loadData + renderToSVG` p50, p95, max. Each render loads the MEI again, as a session would |
| Heap | Worker WASM heap (`HEAPU8.length`, the linear memory size) and, where `performance.memory` exists (Chromium), the page's JS heap. Safari has no `performance.memory`, so it prints n/a |

## Decision rule (from the plan)

Keep Verovio if all of these hold on the floor device (iPad 9th gen, installed PWA or Safari tab):

1. cold init from cache is at most 1.5 s,
2. warm render p95 is at most 100 ms,
3. brotli size is at most 5 MB.

Otherwise build `SvgStaffRenderer` and keep Verovio for M7 imports only (lazy, off the READ path).

## CSP check

No change to `kit.csp` or `_headers` was needed. The existing policy already has `script-src 'self' 'wasm-unsafe-eval'` (the WASM is compiled from an in-memory buffer) and `worker-src 'self' blob:` (the worker is a same-origin file served from `/_app/immutable/workers/`). The e2e test runs against the built site with the meta CSP in place and fails on any console or page error, and it passes in Chromium. WebKit is checked in CI. One build setting was added: `worker: { format: "es" }` in `vite.config.ts`, because the default worker format (iife) cannot bundle Verovio's module (top-level await, `import.meta.url`).

## Service worker

The Verovio chunk is 8 MB raw. SvelteKit lists every immutable file in the service worker manifest, so it would have been precached on every install and update. To keep this task honest to "no notation chunks in the precache", `src/service-worker/index.ts` filters paths matching `/verovio/i` out of `PRECACHE_URLS`. T3.4 replaces this with cache-first serving from the asset cache.

## Size check

`pnpm --filter @clavis/web notation-size` (or `node apps/web/scripts/notation-size.mjs`, after a build) prints raw, gzip and brotli per notation file and in total. It exits 1 if any of the three totals is more than 10% above `apps/web/notation-size-baseline.json`, and 2 if the build is missing. After an intended change (a Verovio upgrade), run it with `--update` and commit the new baseline. CI runs it in the `e2e` job right after the Playwright step, whose web server builds the app.

## Desktop numbers (Chromium, this sandbox)

Chromium 156 (Playwright, Linux x64, no throttling) on a shared machine whose load average was 17 to 30 during the runs, so treat the timings as noisy and pessimistic; the size numbers are exact. Four back-to-back Benchmark runs in one test session (each starts a fresh worker, so runs 2 to 4 have the script in the HTTP cache):

| Metric | Result |
|---|---|
| Verovio version | 6.3.0 |
| Size, raw / gzip / brotli | 7.84 MB (8,216,710 B) / 2.29 MB (2,396,565 B) / 1.76 MB (1,846,346 B) |
| Cold init (create to ready) | 1.59 to 2.71 s (runs: 2.71, 1.59, 1.65, 2.14) |
| of which in the worker, module / toolkit | 0.37 to 1.33 s / 0.10 to 0.16 s |
| First render (round trip) | 111 to 263 ms |
| Warm round trip p50 / p95 | 22.5 to 34.4 ms / 59.9 to 116.3 ms |
| Warm in-worker p50 / p95 | 19.3 to 28.7 ms / 46.9 to 112.2 ms |
| Worker WASM heap | 128 MB (Emscripten initial memory) |
| Page JS heap used | about 6.5 MB |

An earlier run, while the whole Playwright suite ran in parallel on the same loaded machine, gave cold init 7.1 s and p95 284 ms, which shows how sensitive the numbers are to CPU contention. Rerun on a quiet machine before quoting them.

Reading: size passes with a wide margin (1.76 MB against 5 MB). On a loaded desktop, cold init from cache is already around the 1.5 s limit and warm p95 around the 100 ms limit. An iPad 9th gen (A13) is slower than a desktop core, so both timing thresholds are at real risk. The module creation step (decoding 8 MB of base64 and compiling the WASM) dominates cold init. Possible mitigations if the devices are borderline, to try before choosing the fallback: keep the worker alive across the session so the cost is paid once, ship the `.wasm` as a separate file and use `WebAssembly.instantiateStreaming` (needs a Verovio build with the WASM external, not the npm single-file module), and preload on the first READ-capable launch. The 128 MB initial heap is also worth watching on iPhone.

## Device results

On each device, open <https://clavis.clavis-7fc.workers.dev/dev/notation> in Safari (after the branch is deployed), tap **Benchmark**, wait for the table, then tap **Benchmark** a second time. The second run measures cold init with the worker script in the HTTP cache, which is the number the decision uses. Tap **Copy JSON** and paste it under the device heading. Repeat once as the installed PWA (Add to Home Screen), and once in airplane mode after one online load if you want the offline path (note the service worker does not cache this chunk yet, so offline will fail until T3.4). Close other apps first, and note the iOS version (it is in the user agent).

| Device | Run | Cold init (ms) | First render (ms) | Warm p50 (ms) | Warm p95 (ms) | WASM heap | Notes |
|---|---|---|---|---|---|---|---|
| iPhone, iOS 18.7, Safari 27.0.1 (installed PWA, T3.4 runtime) | cached | 138 | 16 | 3 | 7 | n/a | Measured 2026-10-12 through the T3.4 client on `/dev/notation` |
| iPad 9th gen, iPadOS | not run | | | | | | Waived: the decision was accepted on the iPhone numbers (2026-10-17) |

Paste the JSON for each run below:

```json
{
  "userAgent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0.1 Mobile/15E148 Safari/604.1",
  "coldInitMs": 138,
  "firstRenderMs": 16,
  "warmRenders": 50,
  "warmRoundTripMs": { "p50": 3, "p95": 7, "max": 10 },
  "jsHeapUsedBytes": null,
  "jsHeapLimitBytes": null
}
```

## Decision

**Keep Verovio.** Accepted on the iPhone evidence on 2026-10-17, without the iPad 9th gen run. On the iPhone the T3.4 runtime cold-starts in 138 ms and renders at 7 ms p95, an order of magnitude inside the 1.5 s and 100 ms limits. Brotli size (1.76 MB) is well inside 5 MB. An A13 iPad is slower than a current iPhone but not by 10x, so the floor device is expected to pass. If a floor iPad later shows cold init above 1.5 s or warm p95 above 100 ms, the fallback still applies: build `SvgStaffRenderer` behind `NotationRenderer` for READ and keep Verovio lazy for M7 imports.
