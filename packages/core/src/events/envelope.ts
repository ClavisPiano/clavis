import { z } from "zod";
import { ULID_REGEX } from "./ulid.js";

/** Standard fields on every event. Each type overrides `type` and `v`. */
export const envelopeShape = {
  id: z.string().regex(ULID_REGEX, "must be a ULID"),
  deviceId: z.string().min(1),
  at: z.int(),
  type: z.string(),
  v: z.int().min(1),
};
