import { createUlidGenerator, getOrCreateDevice, type EventStore } from "@clavis/core";
import { DexieEventStore } from "@clavis/store";

export type AppStoreResult =
  | { readonly ok: true; readonly store: EventStore; readonly deviceId: string }
  | { readonly ok: false; readonly error: unknown };

export interface AppStoreDeps {
  createStore: () => EventStore;
  now: () => number;
  randomBytes: (length: number) => Uint8Array;
  platform: string;
  userAgent?: string;
  logError?: (message: string, error: unknown) => void;
}

/**
 * Builds a memoized initializer: the store is created once, the device is registered once, and
 * every caller gets the same promise. Never rejects; failures (for example IndexedDB blocked in
 * private mode) resolve to `{ ok: false }` so the app can show a notice instead of crashing.
 */
export function createAppStoreInitializer(deps: AppStoreDeps): () => Promise<AppStoreResult> {
  let pending: Promise<AppStoreResult> | undefined;
  return () => {
    pending ??= (async (): Promise<AppStoreResult> => {
      try {
        const store = deps.createStore();
        const { deviceId } = await getOrCreateDevice(store, {
          newId: createUlidGenerator({ now: deps.now, randomBytes: deps.randomBytes }),
          now: deps.now,
          platform: deps.platform,
          ...(deps.userAgent === undefined ? {} : { userAgent: deps.userAgent }),
        });
        return { ok: true, store, deviceId };
      } catch (error) {
        (deps.logError ?? console.error)("Local storage is unavailable", error);
        return { ok: false, error };
      }
    })();
    return pending;
  };
}

export function detectPlatform(nav: {
  userAgentData?: { platform?: string };
  platform?: string;
}): string {
  for (const candidate of [nav.userAgentData?.platform, nav.platform]) {
    if (candidate) return candidate;
  }
  return "unknown";
}

let singleton: (() => Promise<AppStoreResult>) | undefined;

/** Client-only. Lazily creates the one `DexieEventStore` ("clavis") and registers the device. */
export function initAppStore(): Promise<AppStoreResult> {
  singleton ??= createAppStoreInitializer({
    createStore: () => new DexieEventStore({ name: "clavis" }),
    now: () => Date.now(),
    randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
    platform: detectPlatform(navigator),
    userAgent: navigator.userAgent,
  });
  return singleton();
}
