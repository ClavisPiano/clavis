import { version } from "$app/env";
import { assets, immutable, prerendered } from "$app/manifest";
import { self as sw } from "$app/service-worker";
import { parseCuePayload } from "../lib/pwa/cue-payload";
import { networkFirst } from "../lib/pwa/navigate";
import {
  WARM_NOTATION_MESSAGE,
  isWorkerChunk,
  relativeImports,
  splitPrecache,
} from "../lib/pwa/precache";

// Versioned precache: replaced wholesale on every deploy, old ones deleted on activate.
const PRECACHE = `clavis-precache-${version}`;
const PRECACHE_PREFIX = "clavis-precache-";

// Runtime cache for large, rarely changing assets. Today that is the notation (Verovio) chunk;
// piano samples and Verovio fonts are intended to follow. Files are stored under their
// content-hashed URL, served cache-first, and never evicted by deploys. This cache is deliberately
// not versioned by app release so that large files are not re-downloaded on every update. Bump
// the suffix only when the asset format changes, and delete older `clavis-assets-*` caches then.
// The activate handler below only ever deletes `clavis-precache-*` caches, so this one survives
// updates.
export const ASSET_CACHE = "clavis-assets-v1";

// adapter-static emits the SPA fallback as index.html, which hosts serve for "/". It is not listed
// in the manifest. Fetch "/" rather than "/index.html": static hosts redirect the latter to "/".
const SHELL = "/";

// Manifest paths are relative to the worker's own URL (no leading slash, no base), so resolve
// them to absolute URLs. This also makes the requests below comparable by href.
// The Verovio worker chunk (about 8 MB, WASM inlined) stays out of the precache: it would make
// every install and update download it. It is served cache-first from ASSET_CACHE instead.
const split = splitPrecache([...immutable, ...assets, ...prerendered].map((entry) => entry.path));
const toUrl = (path: string): string => new URL(path, sw.location.href).href;
const PRECACHE_URLS: string[] = [...split.precache, SHELL].map(toUrl);
const NOTATION_URLS: string[] = split.notation.map(toUrl);
const PRECACHED = new Set(PRECACHE_URLS);
const NOTATION = new Set(NOTATION_URLS);

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
  if (typeof data !== "object" || data === null || !("type" in data)) return;
  if (data.type === "SKIP_WAITING") {
    void sw.skipWaiting();
  } else if (data.type === WARM_NOTATION_MESSAGE) {
    // The app sends this after its first online load. Failures are fine: the next load retries,
    // and a notation request that finds the cache empty fills it itself.
    event.waitUntil(warmNotation().catch(() => undefined));
  }
});

// Practice cue (T6.4). The Worker sends an encrypted JSON payload `{ title, body, url }`. Every push
// must show a notification (userVisibleOnly), so a missing or malformed payload falls back to a
// generic one. Precaching and fetch handling above are unaffected.
sw.addEventListener("push", (event) => {
  const cue = parseCuePayload(event.data);
  event.waitUntil(
    sw.registration.showNotification(cue.title, {
      body: cue.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      // One cue notification at a time: a newer one replaces an unread older one.
      tag: "practice-cue",
      data: { url: cue.url },
    }),
  );
});

sw.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data: unknown = event.notification.data;
  const path = typeof data === "object" && data !== null && "url" in data ? data.url : "/";
  const target = new URL(typeof path === "string" ? path : "/", sw.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === sw.location.origin);
      if (open) {
        await open.focus();
      } else {
        await sw.clients.openWindow(target);
      }
    })(),
  );
});

sw.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== sw.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(navigate(request));
    return;
  }
  const href = url.href;
  if (PRECACHED.has(href)) {
    event.respondWith(cacheFirst(href, request));
  } else if (NOTATION.has(href) || isWorkerChunk(href)) {
    event.respondWith(assetCacheFirst(href));
  }
});

// Cache-first from the asset cache, filled on first fetch. Only complete 200 responses are stored.
async function assetCacheFirst(href: string): Promise<Response> {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(href, { ignoreVary: true });
  if (cached) return cached;
  const response = await fetch(href);
  if (response.status === 200) await cache.put(href, response.clone());
  return response;
}

// Background fill after the first online load, so notation works offline without having been used.
async function warmNotation(): Promise<void> {
  const cache = await caches.open(ASSET_CACHE);
  // The queue grows with each script's relative imports: Rolldown puts small shared chunks next to
  // the worker bundle, and the manifest does not list them.
  const queue = [...NOTATION_URLS];
  const seen = new Set(queue);
  for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
    let response = await cache.match(url, { ignoreVary: true });
    if (!response) {
      const fetched = await fetch(url);
      if (fetched.status !== 200) continue;
      await cache.put(url, fetched.clone());
      response = fetched;
    }
    if (!url.endsWith(".js")) continue;
    for (const dep of relativeImports(await response.text(), url)) {
      if (!seen.has(dep) && !PRECACHED.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
}

async function cacheFirst(href: string, request: Request): Promise<Response> {
  // ignoreVary: some servers send `Vary: Origin`, and module script requests carry different
  // headers than the plain requests used to fill the cache. Precached files are immutable.
  const cached = await caches.match(href, { cacheName: PRECACHE, ignoreVary: true });
  return cached ?? fetch(href === request.url ? request : href);
}

// Network first so a fresh deploy's shell is used when online, falling back to the precached SPA
// shell (which client-side routing turns into the right page) when offline.
async function navigate(request: Request): Promise<Response> {
  return networkFirst(
    () => fetch(request),
    async () => {
      const cache = await caches.open(PRECACHE);
      const shell = await cache.match(new URL(SHELL, sw.location.href).href, { ignoreVary: true });
      return shell ?? Response.error();
    },
  );
}
