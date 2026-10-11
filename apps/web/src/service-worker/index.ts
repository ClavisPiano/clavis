import { version } from "$app/env";
import { assets, immutable, prerendered } from "$app/manifest";
import { self as sw } from "$app/service-worker";

// Versioned precache: replaced wholesale on every deploy, old ones deleted on activate.
const PRECACHE = `clavis-precache-${version}`;
const PRECACHE_PREFIX = "clavis-precache-";

// Reserved for runtime caching of large, rarely changing assets (piano samples, WASM, Verovio
// fonts). Intended strategy, not implemented yet: these are fetched on demand (or by an explicit
// "download for offline" action), stored here under their content-hashed URL, served cache-first,
// and never evicted by deploys. This cache is deliberately not versioned by app release so that
// hundreds of MB are not re-downloaded on every update. Bump the suffix only when the asset
// format changes, and delete older `clavis-assets-*` caches then. The activate handler below
// only ever deletes `clavis-precache-*` caches, so this one survives updates.
export const ASSET_CACHE = "clavis-assets-v1";

// adapter-static emits the SPA fallback as index.html, which hosts serve for "/". It is not listed
// in the manifest. Fetch "/" rather than "/index.html": static hosts redirect the latter to "/".
const SHELL = "/";

// Manifest paths are relative to the worker's own URL (no leading slash, no base), so resolve
// them to absolute URLs. This also makes the requests below comparable by href.
// The Verovio worker chunk (about 8 MB, WASM inlined) stays out of the precache: it would make
// every install and update download it. T3.4 serves it cache-first from ASSET_CACHE instead.
const NOTATION_ASSET = /verovio/i;
const PRECACHE_URLS: string[] = [
  ...[...immutable, ...assets, ...prerendered]
    .map((entry) => entry.path)
    .filter((path) => !NOTATION_ASSET.test(path)),
  SHELL,
].map((path) => new URL(path, sw.location.href).href);
const PRECACHED = new Set(PRECACHE_URLS);

sw.addEventListener("install", (event) => {
  // No skipWaiting here: a new worker waits until the app asks for it (see lib/pwa/update.ts),
  // so an update never lands in the middle of a session.
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PRECACHE);
      await cache.addAll(PRECACHE_URLS.map((url) => new Request(url, { cache: "reload" })));
    })(),
  );
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith(PRECACHE_PREFIX) && name !== PRECACHE) await caches.delete(name);
      }
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener("message", (event) => {
  const data: unknown = event.data;
  if (typeof data === "object" && data !== null && "type" in data && data.type === "SKIP_WAITING") {
    void sw.skipWaiting();
  }
});

sw.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== sw.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(navigate(request));
  } else if (PRECACHED.has(url.href)) {
    event.respondWith(cacheFirst(request));
  }
});

async function cacheFirst(request: Request): Promise<Response> {
  // ignoreVary: some servers send `Vary: Origin`, and module script requests carry different
  // headers than the plain requests used to fill the cache. Precached files are immutable.
  const cached = await caches.match(request, { cacheName: PRECACHE, ignoreVary: true });
  return cached ?? fetch(request);
}

// Network first so a fresh deploy's shell is used when online, falling back to the precached SPA
// shell (which client-side routing turns into the right page) when offline.
async function navigate(request: Request): Promise<Response> {
  try {
    return await fetch(request);
  } catch {
    const cache = await caches.open(PRECACHE);
    const shell = await cache.match(new URL(SHELL, sw.location.href).href, { ignoreVary: true });
    return shell ?? Response.error();
  }
}
