import { z } from "zod";
import { ULID_REGEX } from "./ulid.js";

/*
 * Event schema rules
 * - Never edit a shipped schema version. Add a new version to the type's
 *   registry entry and teach its `upcast` to lift older versions to the latest.
 * - Every event schema is strict: unknown keys (including `userId`) are rejected.
 *   The server binds the user from auth (R7), never from the payload.
 * - The `LearningEvent` union always holds the LATEST version of each type.
 */

const envelopeShape = {
  id: z.string().regex(ULID_REGEX, "must be a ULID"),
  deviceId: z.string().min(1),
  at: z.int(),
  type: z.string(),
  v: z.int().min(1),
};

export const SettingsPatch = z.strictObject({
  budgetSec: z.int().min(60).max(3600).optional(),
  awayBudgetSec: z.int().min(60).max(1800).optional(),
  voiceRangeLow: z.int().min(21).max(108).optional(),
  voiceRangeHigh: z.int().min(21).max(108).optional(),
  headphones: z.boolean().optional(),
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
  patch: SettingsPatch,
});

/** Latest version of every event type. Extend this list when adding types. */
export const learningEventSchema = z.discriminatedUnion("type", [
  DeviceRegisteredV1,
  SettingsChangedV1,
]);
export type LearningEvent = z.infer<typeof learningEventSchema>;
export type LearningEventType = LearningEvent["type"];

export interface EventRegistryEntry {
  /** Schema per shipped version number. Append only. */
  versions: Readonly<Record<number, z.ZodType>>;
  /** Lift a validated event of any shipped version to the latest shape. */
  upcast: (event: unknown, fromVersion: number) => unknown;
}

const identity = (event: unknown): unknown => event;

export const eventRegistry: Readonly<Record<LearningEventType, EventRegistryEntry>> = {
  "device.registered": { versions: { 1: DeviceRegisteredV1 }, upcast: identity },
  "settings.changed": { versions: { 1: SettingsChangedV1 }, upcast: identity },
};

export type ParseEventError =
  | { code: "malformed"; message: string }
  | { code: "unknown_type"; message: string }
  | { code: "unknown_version"; message: string }
  | { code: "invalid"; message: string; issues: z.core.$ZodIssue[] };

export type ParseEventResult =
  { ok: true; event: LearningEvent } | { ok: false; error: ParseEventError };

const typeAndVersion = z.looseObject({ type: z.string(), v: z.int().min(1) });

/** Validate unknown input and upcast it to the latest version. Never throws. */
export function parseEvent(input: unknown): ParseEventResult {
  const head = typeAndVersion.safeParse(input);
  if (!head.success) {
    return {
      ok: false,
      error: { code: "malformed", message: "event needs a string `type` and integer `v` >= 1" },
    };
  }
  const { type, v } = head.data;
  if (!Object.hasOwn(eventRegistry, type)) {
    return { ok: false, error: { code: "unknown_type", message: `unknown event type: ${type}` } };
  }
  const entry = eventRegistry[type as LearningEventType];
  const schema = Object.hasOwn(entry.versions, v) ? entry.versions[v] : undefined;
  if (!schema) {
    return {
      ok: false,
      error: { code: "unknown_version", message: `unknown version ${String(v)} of ${type}` },
    };
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "invalid",
        message: z.prettifyError(parsed.error),
        issues: parsed.error.issues,
      },
    };
  }
  const latest = learningEventSchema.safeParse(entry.upcast(parsed.data, v));
  if (!latest.success) {
    return {
      ok: false,
      error: {
        code: "invalid",
        message: z.prettifyError(latest.error),
        issues: latest.error.issues,
      },
    };
  }
  return { ok: true, event: latest.data };
}
