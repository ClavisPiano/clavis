import { z } from "zod";

/** FSRS review rating derived from an attempt (spec 5.2). */
export const RATINGS = ["again", "hard", "good", "easy"] as const;
export const RatingSchema = z.enum(RATINGS);
export type Rating = z.infer<typeof RatingSchema>;

/** Session mode (R3). Away attempts are capped at "good" and never count toward mastery. */
export const SessionModeSchema = z.enum(["instrument", "away"]);
export type SessionMode = z.infer<typeof SessionModeSchema>;
