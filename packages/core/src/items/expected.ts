import { z } from "zod";

/**
 * What an item expects the learner to produce. Written by item generators
 * (core/items) and consumed by `@clavis/scoring`, which may only import core
 * types. Everything scoring needs is therefore precomputed here as data, for
 * example degree labels, so scoring never calls theory functions.
 *
 * R29: only the played part is graded, so every generator emits `play` and none emits `sing`.
 * The `sing` targets are kept so that anything written under R12 (a sung part and a played part,
 * both of which had to be right) still parses. Nothing reads them.
 */

const midi = z.int().min(0).max(127);

/**
 * Degree label for each pitch class (index 0 = C ... 11 = B) in the
 * presentation key, e.g. "1", "b3", "#4". Used to name confusions such as
 * "degree.confusion.6-5" without theory at scoring time.
 */
export const DegreeLabelsSchema = z.array(z.string().min(1)).length(12);
export type DegreeLabels = z.infer<typeof DegreeLabelsSchema>;

export const PitchClassTargetSchema = z.strictObject({
  kind: z.literal("pitchClass"),
  targetMidi: midi,
  degreeLabels: DegreeLabelsSchema,
});

export const ExactPitchTargetSchema = z.strictObject({
  kind: z.literal("exactPitch"),
  targetMidi: midi,
});

export const SequenceTargetSchema = z.strictObject({
  kind: z.literal("sequence"),
  midi: z.array(midi).min(1),
  /** True when only pitch classes must match (ear cells); false for reading. */
  octaveAgnostic: z.boolean(),
  degreeLabels: DegreeLabelsSchema,
});

export const RhythmTargetSchema = z.strictObject({
  kind: z.literal("rhythm"),
  /** Onsets in beats from the first note (first is 0). */
  onsetsBeats: z.array(z.number().min(0)).min(1),
  tempoBpm: z.number().positive(),
  beatsPerBar: z.int().positive(),
  /** Pitch used for the stimulus; responses are scored on timing only. */
  pitch: midi.optional(),
});

/**
 * A short line played from the score (MP, TP.4): exact pitches and the timing of each note.
 * Graded in two stages, pitch first and then rhythm, from the same performance.
 */
export const LineTargetSchema = z
  .strictObject({
    kind: z.literal("line"),
    /** One MIDI number per note, octave exact. */
    midi: z.array(midi).min(1),
    /** Onset of each note in beats from the first note (first is 0), one per entry in `midi`. */
    onsetsBeats: z.array(z.number().min(0)).min(1),
    tempoBpm: z.number().positive(),
    beatsPerBar: z.int().positive(),
  })
  .refine((l) => l.midi.length === l.onsetsBeats.length, {
    message: "a line needs one onset per note",
    path: ["onsetsBeats"],
  });
export type LineTarget = z.infer<typeof LineTargetSchema>;

/**
 * A progression of block chords played together, one chord per entry (T5.3). Graded by performance
 * alignment (`alignPerformance` in scoring) against every chord tone, so it needs polyphonic input
 * (MIDI, or the on-screen keys). The roman numeral and symbol travel with each chord so feedback
 * can say "in the IV chord" without theory at scoring time.
 */
export const ChordLineTargetSchema = z.strictObject({
  kind: z.literal("chordLine"),
  chords: z
    .array(
      z.strictObject({
        /** "I", "IV", "vi". */
        roman: z.string().min(1),
        /** "C", "F", "Am". */
        symbol: z.string().min(1),
        /** The chord tones, octave exact. */
        midi: z.array(midi).min(2),
        /** Onset in beats from the first chord (first is 0). */
        onsetBeats: z.number().min(0),
        durationBeats: z.number().positive(),
      }),
    )
    .min(1),
  tempoBpm: z.number().positive(),
  beatsPerBar: z.int().positive(),
  /**
   * False grades the tones only (T5.10): no chord is early or late, a slightly rolled chord is one
   * chord, and `partial` leaves timing out. Absent means timing is graded as well.
   */
  gradeTiming: z.boolean().optional(),
  /**
   * False hides the numerals and symbols while the learner plays, because reading the chord is the
   * task (T5.10). They still name the chord in feedback. Absent means they are shown.
   */
  showLabels: z.boolean().optional(),
});
export type ChordLineTarget = z.infer<typeof ChordLineTargetSchema>;

/** The hand that plays a note: `rh` for the treble staff, `lh` for the bass staff (R27). */
export const HandSchema = z.enum(["lh", "rh"]);
export type Hand = z.infer<typeof HandSchema>;

/**
 * A grand-staff performance (R27): every note of both hands, octave exact and in time, graded by
 * performance alignment (`alignPerformance` in scoring), so it needs polyphonic input (MIDI). Each
 * note keeps its score id and its hand so errors can name the bar, beat and hand ("bar 3: LH
 * late") and mark the note on the staff.
 */
export const PerformanceTargetSchema = z
  .strictObject({
    kind: z.literal("performance"),
    notes: z
      .array(
        z.strictObject({
          /** The score note id (`n3`), or `n3.1` for a tone of a chord, as `expectedFromScore`. */
          id: z.string().min(1),
          midi,
          /** Onset in beats from the downbeat of the first bar, so bar and beat follow from it. */
          onsetBeats: z.number().min(0),
          durationBeats: z.number().positive(),
          hand: HandSchema,
        }),
      )
      .min(1),
    tempoBpm: z.number().positive(),
    beatsPerBar: z.int().positive(),
  })
  .refine((p) => new Set(p.notes.map((n) => n.id)).size === p.notes.length, {
    message: "performance note ids must be unique",
    path: ["notes"],
  });
export type PerformanceTarget = z.infer<typeof PerformanceTargetSchema>;

export const ChoiceOptionSchema = z.strictObject({
  /** Stable id, recorded in errors: "major", "minor". */
  id: z.string().min(1),
  /** Button text: "Major". */
  label: z.string().min(1),
});
export type ChoiceOption = z.infer<typeof ChoiceOptionSchema>;

/**
 * Pick one option (R21). For answers that are not a pitch, such as the quality of a chord, so
 * there is nothing to play or sing. Answered with on-screen buttons in both modes.
 */
export const ChoiceTargetSchema = z
  .strictObject({
    kind: z.literal("choice"),
    options: z.array(ChoiceOptionSchema).min(2).max(6),
    /** The `id` of the right option. */
    correct: z.string().min(1),
  })
  .refine((c) => new Set(c.options.map((o) => o.id)).size === c.options.length, {
    message: "choice option ids must be unique",
  })
  .refine((c) => c.options.some((o) => o.id === c.correct), {
    message: "correct must be one of the options",
  });
export type ChoiceTarget = z.infer<typeof ChoiceTargetSchema>;

export const PlayTargetSchema = z.discriminatedUnion("kind", [
  PitchClassTargetSchema,
  ExactPitchTargetSchema,
  SequenceTargetSchema,
  RhythmTargetSchema,
  LineTargetSchema,
  ChordLineTargetSchema,
  PerformanceTargetSchema,
  ChoiceTargetSchema,
]);
export type PlayTarget = z.infer<typeof PlayTargetSchema>;

/** Legacy (R29): no generator emits sung targets and scoring ignores them. Parse-only. */
export const SungPitchTargetSchema = z.strictObject({
  kind: z.literal("sungPitch"),
  /** Octave-agnostic: the sung pitch class must be within tolerance of this note's. */
  targetMidi: midi,
  toleranceCents: z.number().positive(),
  /** Names confusions for sing-only (Away) attempts, where there is no play target. */
  degreeLabels: DegreeLabelsSchema.optional(),
});

export const SungSequenceTargetSchema = z.strictObject({
  kind: z.literal("sungSequence"),
  midi: z.array(midi).min(1),
  toleranceCents: z.number().positive(),
  degreeLabels: DegreeLabelsSchema.optional(),
});

/** Legacy (R29): parse-only, see `SungPitchTargetSchema`. */
export const SingTargetSchema = z.discriminatedUnion("kind", [
  SungPitchTargetSchema,
  SungSequenceTargetSchema,
]);
export type SingTarget = z.infer<typeof SingTargetSchema>;

export const ExpectedResponseSchema = z
  .strictObject({
    /** Legacy (R12). Never set for new items and never graded. */
    sing: SingTargetSchema.optional(),
    play: PlayTargetSchema.optional(),
    /** How long after stimulus end a response is accepted before timing out. */
    responseWindowMs: z.int().positive(),
  })
  .refine((e) => e.sing !== undefined || e.play !== undefined, {
    message: "expected response needs a sing or play target",
  });
export type ExpectedResponse = z.infer<typeof ExpectedResponseSchema>;
