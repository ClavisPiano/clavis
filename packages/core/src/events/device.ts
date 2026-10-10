import type { Clock } from "../random.js";
import type { EventStore } from "./store.js";

export const DEVICE_ID_META_KEY = "deviceId";

export interface DeviceDeps {
  /** Generates a fresh ULID (used for the device id and the registration event id). */
  newId: () => string;
  now: Clock;
  platform: string;
  userAgent?: string;
}

/**
 * Read the persisted device id, or create it and append a `device.registered`
 * event. Idempotent: later calls return the stored id with `created: false`.
 */
export async function getOrCreateDevice(
  store: EventStore,
  deps: DeviceDeps,
): Promise<{ deviceId: string; created: boolean }> {
  const existing = await store.getMeta(DEVICE_ID_META_KEY);
  if (typeof existing === "string" && existing.length > 0) {
    return { deviceId: existing, created: false };
  }
  const deviceId = deps.newId();
  // Append first: a crash before setMeta leaves a harmless orphan event, never an unregistered device.
  await store.append([
    {
      id: deps.newId(),
      deviceId,
      at: deps.now(),
      type: "device.registered",
      v: 1,
      platform: deps.platform,
      ...(deps.userAgent === undefined ? {} : { userAgent: deps.userAgent }),
    },
  ]);
  await store.setMeta(DEVICE_ID_META_KEY, deviceId);
  return { deviceId, created: true };
}
