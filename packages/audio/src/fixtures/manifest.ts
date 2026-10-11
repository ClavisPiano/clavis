import { z } from "zod";

/**
 * Ground truth manifest for the audio fixture corpus (`fixtures/audio/manifest.json`).
 *
 * Times are milliseconds from the first sample of the file. `onsetMs` is the moment the note
 * starts (from the score plus a count-in click, or annotated). Pure schema code: no file I/O.
 */

export const FIXTURE_KINDS = ["sung-degree", "piano-single", "piano-sequence", "two-hand"] as const;
export const FixtureKindSchema = z.enum(FIXTURE_KINDS);
export type FixtureKind = z.infer<typeof FixtureKindSchema>;

export const FixtureInstrumentSchema = z.enum(["voice", "acoustic-piano", "digital-piano"]);
export type FixtureInstrument = z.infer<typeof FixtureInstrumentSchema>;

export const TruthNoteSchema = z
  .strictObject({
    midi: z.int().min(0).max(127),
    onsetMs: z.number().min(0),
    offsetMs: z.number().min(0).optional(),
  })
  .refine((n) => n.offsetMs === undefined || n.offsetMs > n.onsetMs, {
    message: "offsetMs must be after onsetMs",
  });
export type TruthNote = z.infer<typeof TruthNoteSchema>;

export const FixtureEntrySchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "use lowercase letters, digits and dashes"),
    /** Path relative to `fixtures/audio/`. */
    file: z.string().min(1),
    kind: FixtureKindSchema,
    instrument: FixtureInstrumentSchema,
    /** Recording device, for example "iPhone 15 built-in mic". */
    device: z.string().min(1),
    sampleRate: z.int().positive().optional(),
    notes: z.array(TruthNoteSchema).min(1),
    /** Register hint passed to the pipeline as `expectedRange`. */
    expectedRange: z
      .strictObject({ low: z.int().min(0).max(127), high: z.int().min(0).max(127) })
      .refine((r) => r.low <= r.high, { message: "low must not exceed high" })
      .optional(),
    tags: z.array(z.string()).optional(),
  })
  .refine((e) => !e.file.startsWith("/") && !e.file.split("/").includes(".."), {
    message: "file must be a relative path inside fixtures/audio",
    path: ["file"],
  });
export type FixtureEntry = z.infer<typeof FixtureEntrySchema>;

export const FixtureManifestSchema = z
  .array(FixtureEntrySchema)
  .refine((entries) => new Set(entries.map((e) => e.id)).size === entries.length, {
    message: "fixture ids must be unique",
  });
export type FixtureManifest = z.infer<typeof FixtureManifestSchema>;

export function parseManifest(json: unknown): FixtureManifest {
  return FixtureManifestSchema.parse(json);
}
