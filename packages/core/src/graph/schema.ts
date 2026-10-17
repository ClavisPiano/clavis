import { z } from "zod";

/** Skill strands (spec 3.1). Rhythm is not a strand. */
export const StrandSchema = z.enum(["EAR", "READ", "HANDS", "BYEAR", "APPLY"]);
export type Strand = z.infer<typeof StrandSchema>;

/** Node lifecycle states (spec 3.2). */
export const NodeStateSchema = z.enum(["locked", "available", "learning", "fluent", "mastered"]);
export type NodeState = z.infer<typeof NodeStateSchema>;

export const MasteryCriteriaSchema = z.object({
  /** Fraction correct over the window, 0..1. */
  minAccuracy: z.number().min(0).max(1),
  /** Median latency ceiling. Omitted for nodes where latency is not a mastery signal. */
  maxMedianLatencyMs: z.number().positive().optional(),
  /** Number of most recent attempts the accuracy is computed over. */
  windowAttempts: z.number().int().min(1),
  /** Attempts must span at least this many distinct sessions. */
  distinctSessions: z.number().int().min(1),
});
export type MasteryCriteria = z.infer<typeof MasteryCriteriaSchema>;

/** Exercise generator ids (spec 7). `concept` is reserved for theory cards. */
export const GENERATOR_IDS = [
  "degreeSing",
  "degreeId",
  "cellEcho",
  "rhythmEcho",
  "rhythmRead",
  "bassMotion",
  "chordQuality",
  "progressionId",
  "bassNoteRead",
  "trebleNoteRead",
  "pieceLine",
  "pieceEar",
  "bassChordRead",
  "sightLine",
  "lhPattern",
  "lhPatternVariants",
  "coordTask",
  "byEarPhrase",
  "byEarHarmonise",
  "byEarRecording",
  "concept",
] as const;
export const GeneratorIdSchema = z.enum(GENERATOR_IDS);
export type GeneratorId = z.infer<typeof GeneratorIdSchema>;

/**
 * Skill graph node (spec 3.2). One deliberate deviation from the spec: a node
 * lists several `itemGenerators` (first is the default) rather than a single
 * `itemGenerator`, because degree nodes are drilled both by `degreeSing`
 * (sing then play) and `degreeId` (play only, and the Away tap variant).
 */
export const SkillNodeSchema = z.object({
  id: z.string().min(1),
  strand: StrandSchema,
  title: z.string().min(1),
  /** One-line summary for UI and docs. */
  description: z.string().optional(),
  /** All must be mastered before this node unlocks. */
  prerequisites: z.array(z.string()),
  /** Must be at least "learning" (spec 3.2). */
  softPrerequisites: z.array(z.string()).optional(),
  /** Non-empty; the first entry is the default generator. */
  itemGenerators: z.array(GeneratorIdSchema).min(1),
  params: z.record(z.string(), z.unknown()),
  mastery: MasteryCriteriaSchema,
  /** If true, mastery is tracked per key family (spec 3.4). */
  keyDependent: z.boolean(),
  /** Per-node latency target used by grading (spec 5.2). Omitted when latency is not meaningful. */
  targetLatencyMs: z.number().positive().optional(),
});
export type SkillNode = z.infer<typeof SkillNodeSchema>;

export const GeneratorRequirementSchema = z.enum(["mic", "keys", "polyphonic", "notation"]);
export type GeneratorRequirement = z.infer<typeof GeneratorRequirementSchema>;

export const GeneratorInfoSchema = z.object({
  id: GeneratorIdSchema,
  /** False until the generator exists in core/items. Nodes with no implemented generator are not enabled. */
  implemented: z.boolean(),
  /** Seed for the composer's per-generator seconds-per-item estimate (R13). */
  seedDurationSec: z.number().positive(),
  /** Usable in Away mode (spec 6.5). */
  awayEligible: z.boolean(),
  requires: z.array(GeneratorRequirementSchema),
});
export type GeneratorInfo = z.infer<typeof GeneratorInfoSchema>;

export const SkillGraphSchema = z.object({
  /** Must change whenever graph semantics change; snapshots are keyed by it (R8). */
  contentVersion: z.string().min(1),
  nodes: z.array(SkillNodeSchema),
  generators: z.array(GeneratorInfoSchema),
});
export type SkillGraph = z.infer<typeof SkillGraphSchema>;
