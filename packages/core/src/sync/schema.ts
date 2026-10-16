import { z } from "zod";
import { envelopeShape } from "../events/envelope.js";
import { parseEvent } from "../events/schema.js";

/*
 * Sync protocol (T4.1). The client pushes event envelopes and pulls them back in server order.
 *
 * Forward compatibility: the server accepts any well-formed envelope (`id`, `deviceId`, `at`,
 * `type`, `v`), including types or versions it does not know. Dropping them would lose data
 * written by a newer client that has not been deployed against this server yet. Events whose
 * `type` and `v` ARE known to this build must additionally pass their full payload schema, so a
 * malformed known event is rejected. Events are stored exactly as received (no upcasting): the
 * client upcasts on read. A `userId` key is always rejected (R7: the server binds the user from
 * the auth token, never from the payload).
 */

export const MAX_PUSH_BATCH = 500;
export const DEFAULT_PULL_LIMIT = 500;
export const MAX_PULL_LIMIT = 1000;

/** An event as it travels over the wire: envelope fields plus an opaque payload. */
export const SyncEnvelope = z
  .looseObject(envelopeShape)
  .refine((e) => !Object.hasOwn(e, "userId"), { message: "events must not carry userId" })
  .superRefine((e, ctx) => {
    const known = parseEvent(e);
    if (known.ok) return;
    const { code } = known.error;
    // Unknown type or version: accept (forward compatibility). Anything else is a real defect.
    if (code === "unknown_type" || code === "unknown_version") return;
    ctx.addIssue({ code: "custom", message: known.error.message });
  });
export type SyncEnvelope = z.infer<typeof SyncEnvelope>;

export const PushRequest = z.strictObject({
  events: z.array(SyncEnvelope).max(MAX_PUSH_BATCH),
});
export type PushRequest = z.infer<typeof PushRequest>;

export const PushResponse = z.strictObject({
  accepted: z.int().min(0),
  duplicates: z.int().min(0),
  lastSeq: z.int().min(0),
});
export type PushResponse = z.infer<typeof PushResponse>;

/** Query parameters arrive as strings, so numbers are coerced from them. */
export const PullRequest = z.strictObject({
  after: z.coerce.number().int().min(0),
  limit: z.coerce.number().int().min(1).max(MAX_PULL_LIMIT).optional(),
});
export type PullRequest = z.infer<typeof PullRequest>;

export const PullEntry = z.strictObject({
  serverSeq: z.int().min(1),
  receivedAt: z.int().min(0),
  event: SyncEnvelope,
});
export type PullEntry = z.infer<typeof PullEntry>;

export const PullResponse = z.strictObject({
  events: z.array(PullEntry),
  lastSeq: z.int().min(0),
  hasMore: z.boolean(),
});
export type PullResponse = z.infer<typeof PullResponse>;
