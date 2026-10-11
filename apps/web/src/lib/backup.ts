import {
  DEVICE_ID_META_KEY,
  REDUCER_VERSION,
  compareEvents,
  parseEvent,
  type EventStore,
  type LearnerState,
  type LearnerStateService,
  type LearningEvent,
} from "@clavis/core";

/*
 * Export/import of the event log (T2.11). Until sync lands this file is the user's only backup.
 * Pure helpers first, then `runImport`, which drives a service and its store.
 */

export const EXPORT_FORMAT = "clavis-events";
export const EXPORT_FORMAT_VERSION = 1;
export const IMPORT_BATCH_SIZE = 500;

export interface ExportDocument {
  format: typeof EXPORT_FORMAT;
  formatVersion: typeof EXPORT_FORMAT_VERSION;
  exportedAt: string;
  deviceId: string;
  contentVersion: string;
  reducerVersion: number;
  events: LearningEvent[];
}

export function buildExport(args: {
  events: readonly LearningEvent[];
  deviceId: string;
  contentVersion: string;
  now: Date;
}): ExportDocument {
  return {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: args.now.toISOString(),
    deviceId: args.deviceId,
    contentVersion: args.contentVersion,
    reducerVersion: REDUCER_VERSION,
    events: [...args.events].sort(compareEvents),
  };
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** `clavis-events-<deviceId>-<YYYYMMDD-HHmm>.json`, timestamp in UTC. */
export function exportFilename(deviceId: string, now: Date): string {
  const stamp =
    `${String(now.getUTCFullYear())}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
  return `clavis-events-${deviceId}-${stamp}.json`;
}

export interface ImportError {
  /** Index into `events`, or -1 for an envelope problem. */
  index: number;
  message: string;
}

export type ValidatedImport =
  | { ok: true; events: LearningEvent[]; meta: { deviceId?: string; contentVersion?: string } }
  | { ok: false; errors: ImportError[] };

const envelopeError = (message: string): ValidatedImport => ({
  ok: false,
  errors: [{ index: -1, message }],
});

/**
 * Validates an already JSON-parsed document: envelope first, then every event with `parseEvent`
 * (which upcasts old versions). Collects all event errors; the caller imports nothing on failure.
 */
export function validateImport(doc: unknown): ValidatedImport {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return envelopeError("Not a Clavis export (expected an object)");
  }
  const d = doc as Record<string, unknown>;
  if (d.format !== EXPORT_FORMAT) return envelopeError(`format must be "${EXPORT_FORMAT}"`);
  if (d.formatVersion !== EXPORT_FORMAT_VERSION) {
    return envelopeError(
      `Unsupported formatVersion ${JSON.stringify(d.formatVersion)} (this app reads ${String(EXPORT_FORMAT_VERSION)})`,
    );
  }
  const raw = d.events;
  if (!Array.isArray(raw)) return envelopeError("events must be an array");
  const events: LearningEvent[] = [];
  const errors: ImportError[] = [];
  raw.forEach((item: unknown, index) => {
    const r = parseEvent(item);
    if (r.ok) events.push(r.event);
    else errors.push({ index, message: r.error.message });
  });
  if (errors.length > 0) return { ok: false, errors };
  const meta: { deviceId?: string; contentVersion?: string } = {};
  if (typeof d.deviceId === "string") meta.deviceId = d.deviceId;
  if (typeof d.contentVersion === "string") meta.contentVersion = d.contentVersion;
  return { ok: true, events, meta };
}

/** Parses file text then validates it. */
export function validateImportText(text: string): ValidatedImport {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return envelopeError(`Not valid JSON: ${detail}`);
  }
  return validateImport(doc);
}

export type ImportMode = "merge" | "replace";

export interface ImportResult {
  mode: ImportMode;
  inserted: number;
  skipped: number;
  deleted: number;
  state: LearnerState;
}

/**
 * Appends validated events through the service in batches (idempotent on id). "replace" clears
 * the store first, keeping this device's id; if the import then fails, the previous events are
 * restored before the error is rethrown. Callers must have validated the events already.
 */
export async function runImport(
  service: LearnerStateService,
  store: EventStore,
  events: readonly LearningEvent[],
  mode: ImportMode,
  batchSize = IMPORT_BATCH_SIZE,
): Promise<ImportResult> {
  const sorted = [...events].sort(compareEvents);
  let deleted = 0;
  let baseline = service.state.eventCount;
  let backup: LearningEvent[] | undefined;
  let deviceId: unknown;
  if (mode === "replace") {
    backup = await store.list();
    deleted = backup.length;
    deviceId = await store.getMeta(DEVICE_ID_META_KEY);
    await store.clear();
    if (deviceId !== undefined) await store.setMeta(DEVICE_ID_META_KEY, deviceId);
    await service.load();
    baseline = 0;
  }
  try {
    for (let i = 0; i < sorted.length; i += batchSize) {
      await service.append(sorted.slice(i, i + batchSize));
    }
  } catch (error) {
    if (backup) {
      await store.clear();
      if (deviceId !== undefined) await store.setMeta(DEVICE_ID_META_KEY, deviceId);
      await store.append(backup);
      await service.load();
    }
    throw error;
  }
  const state = service.state;
  const inserted = state.eventCount - baseline;
  const distinct = new Set(sorted.map((e) => e.id)).size;
  return { mode, inserted, skipped: distinct - inserted, deleted, state };
}
