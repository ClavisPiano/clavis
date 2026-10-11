import { z } from "zod";
import { envelopeShape } from "./envelope.js";
import {
  AttemptCompletedV1,
  ItemPresentedV1,
  NodeIntroducedV1,
  PlacementCompletedV1,
  SessionEndedV1,
  SessionStartedV1,
  SessionStartedV2,
} from "./learning.js";

/*
 * Event schema rules
 * - Never edit a shipped schema version. Add a new version to the type's
 *   registry entry and teach its `upcast` to lift older versions to the latest.
 * - Every event schema is strict: unknown keys (including `userId`) are rejected.
 *   The server binds the user from auth (R7), never from the payload.
 * - The `LearningEvent` union always holds the LATEST version of each type.
 */

/*
 * `weeklyTargetDays` (T2.10) was added to the shipped v1 patch as an OPTIONAL key instead of a
 * v2 with an upcaster. Reading is fully backward compatible (old events simply lack the key).
 * The only cost is that a client built before this change would reject a new event that carries
 * the key. That is acceptable here: Clavis ships one client version at a time (a single-user PWA
 * that updates itself), and a v2 would force every concurrent writer of `v: 1` settings events
 * to change in lockstep. Any further change to this patch must be a real new version with an
 * upcaster, and T2.15 did exactly that (v2 adds `newItemsPerDay`).
 */
export const SettingsPatchV1 = z.strictObject({
  budgetSec: z.int().min(60).max(3600).optional(),
  awayBudgetSec: z.int().min(60).max(1800).optional(),
  voiceRangeLow: z.int().min(21).max(108).optional(),
  voiceRangeHigh: z.int().min(21).max(108).optional(),
  headphones: z.boolean().optional(),
  weeklyTargetDays: z.int().min(1).max(7).optional(),
});

/** Patch as of `settings.changed` v2 (T2.15): adds the daily new-item cap. */
export const SettingsPatch = SettingsPatchV1.extend({
  newItemsPerDay: z.int().min(3).max(15).optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatch>;

export const DeviceRegisteredV1 = z.strictObject({
  ...envelopeShape,
  type: z.literal("device.registered"),
  v: z.literal(1),
  platform: z.string(),
  userAgent: z.string().optional(),
});

export const SettingsChangedV1 = z.strictObject({
  ...envelopeShape,
  type: z.literal("settings.changed"),
  v: z.literal(1),
  patch: SettingsPatchV1,
});

export const SettingsChangedV2 = z.strictObject({
  ...envelopeShape,
  type: z.literal("settings.changed"),
  v: z.literal(2),
  patch: SettingsPatch,
});

/** Latest version of every event type. Extend this list when adding types. */
export const learningEventSchema = z.discriminatedUnion("type", [
  DeviceRegisteredV1,
  SettingsChangedV2,
  SessionStartedV2,
  ItemPresentedV1,
  AttemptCompletedV1,
  NodeIntroducedV1,
  PlacementCompletedV1,
  SessionEndedV1,
]);
export type LearningEvent = z.infer<typeof learningEventSchema>;
export type LearningEventType = LearningEvent["type"];

export interface EventRegistryEntry {
  /** Schema per shipped version number. Append only. */
  versions: Readonly<Record<number, z.ZodType>>;
  /** Lift a validated event of any shipped version to the latest shape. */
  upcast: (event: unknown, fromVersion: number) => unknown;
}

export type EventRegistry = Readonly<Record<string, EventRegistryEntry>>;

const identity = (event: unknown): unknown => event;

/** v1 payloads are valid v2 payloads (v2 only adds optional fields), so lifting just bumps `v`. */
const liftToV2 = (event: unknown): unknown =>
  typeof event === "object" && event !== null ? { ...event, v: 2 } : event;

export const eventRegistry: Readonly<Record<LearningEventType, EventRegistryEntry>> = {
  "device.registered": { versions: { 1: DeviceRegisteredV1 }, upcast: identity },
  "settings.changed": {
    versions: { 1: SettingsChangedV1, 2: SettingsChangedV2 },
    upcast: (event, from) => (from === 1 ? liftToV2(event) : event),
  },
  "session.started": {
    versions: { 1: SessionStartedV1, 2: SessionStartedV2 },
    upcast: (event, from) => (from === 1 ? liftToV2(event) : event),
  },
  "item.presented": { versions: { 1: ItemPresentedV1 }, upcast: identity },
  "attempt.completed": { versions: { 1: AttemptCompletedV1 }, upcast: identity },
  "node.introduced": { versions: { 1: NodeIntroducedV1 }, upcast: identity },
  "placement.completed": { versions: { 1: PlacementCompletedV1 }, upcast: identity },
  "session.ended": { versions: { 1: SessionEndedV1 }, upcast: identity },
};

export type ParseEventError =
  | { code: "malformed"; message: string }
  | { code: "unknown_type"; message: string }
  | { code: "unknown_version"; message: string }
  | { code: "invalid"; message: string; issues: z.core.$ZodIssue[] };

export type ParseEventResult =
  { ok: true; event: LearningEvent } | { ok: false; error: ParseEventError };

export type ParseEventWithResult =
  { ok: true; event: unknown } | { ok: false; error: ParseEventError };

const typeAndVersion = z.looseObject({ type: z.string(), v: z.int().min(1) });

function invalid(error: z.ZodError): ParseEventWithResult {
  return {
    ok: false,
    error: { code: "invalid", message: z.prettifyError(error), issues: error.issues },
  };
}

/**
 * Validate against any registry and upcast to the entry's highest version.
 * `parseEvent` uses the module registry; tests can pass their own. Never throws.
 */
export function parseEventWith(registry: EventRegistry, input: unknown): ParseEventWithResult {
  const head = typeAndVersion.safeParse(input);
  if (!head.success) {
    return {
      ok: false,
      error: { code: "malformed", message: "event needs a string `type` and integer `v` >= 1" },
    };
  }
  const { type, v } = head.data;
  const entry = Object.hasOwn(registry, type) ? registry[type] : undefined;
  if (!entry) {
    return { ok: false, error: { code: "unknown_type", message: `unknown event type: ${type}` } };
  }
  const schema = Object.hasOwn(entry.versions, v) ? entry.versions[v] : undefined;
  if (!schema) {
    return {
      ok: false,
      error: { code: "unknown_version", message: `unknown version ${String(v)} of ${type}` },
    };
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const latestVersion = Math.max(...Object.keys(entry.versions).map(Number));
  const latestSchema = entry.versions[latestVersion];
  if (!latestSchema) {
    return { ok: false, error: { code: "unknown_version", message: `no schema for ${type}` } };
  }
  const latest = latestSchema.safeParse(entry.upcast(parsed.data, v));
  if (!latest.success) return invalid(latest.error);
  return { ok: true, event: latest.data };
}

/** Validate unknown input and upcast it to the latest version. Never throws. */
export function parseEvent(input: unknown): ParseEventResult {
  // The module registry's latest schemas are exactly the `LearningEvent` union.
  return parseEventWith(eventRegistry, input) as ParseEventResult;
}
