import { z } from "zod";
import type { Midi } from "../theory/keys.js";

/*
 * Notation-free score contract for visual items (R17, R18). Core decides what is written (spelling, written
 * accidentals, ties); the notation package only draws it. Plain JSON, so an ItemInstance
 * carrying a ScoreSpec stays serializable.
 */

export const StepSchema = z.enum(["C", "D", "E", "F", "G", "A", "B"]);
export type Step = z.infer<typeof StepSchema>;

export const SpelledPitchSchema = z.strictObject({
  step: StepSchema,
  /** Semitone alteration of the sounding pitch: -2 double flat .. 2 double sharp. */
  alter: z.number().int().min(-2).max(2),
  /** Scientific octave number (C4 = middle C). */
  octave: z.number().int().min(0).max(9),
});
export type SpelledPitch = z.infer<typeof SpelledPitchSchema>;

export const DurationSchema = z.strictObject({
  /** Note value as a denominator: 1 whole, 2 half, 4 quarter, 8 eighth, 16 sixteenth. */
  value: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8), z.literal(16)]),
  dots: z.union([z.literal(0), z.literal(1)]),
  /** Tie role of this note. "start" ties to the next note, "stop" ends a tie, "continue" does both. */
  tie: z.enum(["start", "continue", "stop"]).optional(),
});
export type Duration = z.infer<typeof DurationSchema>;

export const WrittenAccidentalSchema = z.enum([
  "sharp",
  "flat",
  "natural",
  "double-sharp",
  "double-flat",
]);
export type WrittenAccidental = z.infer<typeof WrittenAccidentalSchema>;

export const ScoreNoteSchema = z.strictObject({
  kind: z.literal("note"),
  /** Stable id (`n1`, `n2`, ...), unique across the score. Used for highlighting. */
  id: z.string().regex(/^n[0-9]+$/),
  /** More than one pitch is a chord. */
  pitches: z.array(SpelledPitchSchema).min(1),
  duration: DurationSchema,
  /**
   * The accidental written before the note, decided by core. Absent means none is written,
   * for example because the key signature already implies the alteration.
   */
  accidental: WrittenAccidentalSchema.optional(),
});
export type ScoreNote = z.infer<typeof ScoreNoteSchema>;

export const ScoreRestSchema = z.strictObject({
  kind: z.literal("rest"),
  duration: DurationSchema,
});
export type ScoreRest = z.infer<typeof ScoreRestSchema>;

/**
 * One staff. Measures live on the staff (not on the score) so that a grand staff can hold
 * different content per staff.
 */
export const StaffSpecSchema = z
  .strictObject({
    clef: z.enum(["bass", "treble", "percussion"]),
    lines: z.union([z.literal(5), z.literal(1)]),
    measures: z.array(z.array(z.union([ScoreNoteSchema, ScoreRestSchema]))),
  })
  .refine((s) => (s.clef === "percussion") === (s.lines === 1), {
    message: "percussion clef requires 1 line and other clefs require 5",
    path: ["lines"],
  });
export type StaffSpec = z.infer<typeof StaffSpecSchema>;

/** Length of a measure in whole notes, so staves can be compared without a meter. */
function measureWholes(measure: StaffSpec["measures"][number]): number {
  return measure.reduce(
    (sum, el) => sum + (1 / el.duration.value) * (el.duration.dots === 1 ? 1.5 : 1),
    0,
  );
}

export const ScoreSpecSchema = z
  .strictObject({
    /**
     * One staff, or a grand staff (R27): treble then bass, joined by a brace, with the same
     * number of measures and each measure as long on both staves.
     */
    staves: z.array(StaffSpecSchema).min(1).max(2),
    key: z.strictObject({ tonic: z.string(), mode: z.enum(["major", "minor"]) }).nullable(),
    meter: z
      .strictObject({
        beats: z.number().int().min(1),
        beatValue: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]),
      })
      .nullable(),
  })
  .refine(
    (s) => {
      const ids = scoreNoteIds(s);
      return new Set(ids).size === ids.length;
    },
    { message: "note ids must be unique across the score", path: ["staves"] },
  )
  .superRefine((s, ctx) => {
    const [upper, lower] = s.staves;
    if (upper === undefined || lower === undefined) return;
    if (upper.clef !== "treble" || lower.clef !== "bass") {
      ctx.addIssue({
        code: "custom",
        message: "a grand staff is a treble staff above a bass staff",
        path: ["staves"],
      });
    }
    if (upper.measures.length !== lower.measures.length) {
      ctx.addIssue({
        code: "custom",
        message: "both staves of a grand staff need the same number of measures",
        path: ["staves", 1, "measures"],
      });
      return;
    }
    upper.measures.forEach((m, i) => {
      const other = lower.measures[i] ?? [];
      // Durations are sums of powers of two, so the comparison is exact.
      if (measureWholes(m) !== measureWholes(other)) {
        ctx.addIssue({
          code: "custom",
          message: `measure ${String(i + 1)} has a different length on each staff`,
          path: ["staves", 1, "measures", i],
        });
      }
    });
  });
export type ScoreSpec = z.infer<typeof ScoreSpecSchema>;

/** Note ids in document order (staff by staff, measure by measure). */
export function scoreNoteIds(score: Pick<ScoreSpec, "staves">): string[] {
  const ids: string[] = [];
  for (const staff of score.staves)
    for (const measure of staff.measures)
      for (const el of measure) if (el.kind === "note") ids.push(el.id);
  return ids;
}

const STEP_SEMITONES: Record<Step, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** MIDI number of a spelled pitch (C4 = 60). */
export function spelledToMidi(p: SpelledPitch): Midi {
  return (p.octave + 1) * 12 + STEP_SEMITONES[p.step] + p.alter;
}
