import { z } from "zod";

/** A statement is one plain sentence, short enough for a summary line. */
export const MAX_MILESTONE_CHARS = 140;

/**
 * A capability milestone (T6.3, spec 14): the plain statement shown when `nodeId` is first
 * mastered. The text lives in `@clavis/content`; the schema is here so core helpers can use it.
 */
export const MilestoneSchema = z.strictObject({
  nodeId: z.string().min(1),
  statement: z.string().min(1).max(MAX_MILESTONE_CHARS),
});
export type Milestone = z.infer<typeof MilestoneSchema>;
