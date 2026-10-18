import { MilestoneSchema, type Milestone } from "@clavis/core";

/*
 * Capability milestones (T6.3, spec 14): one plain statement per node, shown when the node is first
 * mastered. Rules in `docs/content/cards.md`: plain words, British spelling, no em dashes, say what
 * the learner can now do, no cheering. Core caps a statement at 140 characters.
 */
const MILESTONES_V1: unknown[] = [
  {
    nodeId: "ear.degrees.major.135",
    statement: "You can hear scale degrees 1, 3 and 5 in any major key and play them.",
  },
  {
    nodeId: "ear.rhythm.echo",
    statement: "You can listen to a rhythm of one or two bars and play it back in time.",
  },
  {
    nodeId: "ear.degrees.major.diatonic",
    statement: "You can hear all seven degrees of a major scale in any key and play them.",
  },
  {
    nodeId: "ear.cells.major.2-4",
    statement: "You can listen to a short tune of two to four notes and play it back.",
  },
  {
    nodeId: "ear.bass.I-IV-V-vi",
    statement: "You can hear the root of each chord in a I, IV, V and vi progression and play it.",
  },
  {
    nodeId: "ear.quality.triad",
    statement: "You can hear whether a triad is major or minor.",
  },
  {
    nodeId: "ear.prog.core",
    statement: "You can tell I-V-vi-IV, I-IV-V, ii-V-I and vi-IV-I-V apart by ear in any key.",
  },
  {
    nodeId: "ear.cadence",
    statement:
      "You can hear whether a phrase ends with a perfect, plagal, imperfect or deceptive cadence.",
  },
  {
    nodeId: "ear.prog.minor",
    statement:
      "You can recognise the common minor key progressions, including the Andalusian cadence.",
  },
  {
    nodeId: "ear.prog.colour",
    statement:
      "You can hear a secondary dominant, a borrowed minor iv and a flat seven chord in a progression.",
  },
  {
    nodeId: "byear.melody.simple",
    statement: "You can hear a short melody, hold it in your head and then play it on the piano.",
  },
  {
    nodeId: "hands.lh.triads.root",
    statement: "You can play root position I, IV, V and vi chords with your left hand in any key.",
  },
  {
    nodeId: "ear.degrees.minor",
    statement: "You can hear the degrees of a minor scale in any key and play them.",
  },
  {
    nodeId: "read.bass.landmarks",
    statement: "You can find the bass clef landmarks, low C, F, G and middle C, on the keyboard.",
  },
  {
    nodeId: "read.rhythm.basic",
    statement:
      "You can read and play simple rhythms with quarters, eighths, dotted quarters and ties.",
  },
  {
    nodeId: "read.bass.steps",
    statement: "You can read bass clef notes one step from a landmark.",
  },
  {
    nodeId: "read.bass.skips",
    statement: "You can read the bass clef from low C up to the E above middle C.",
  },
  {
    nodeId: "read.bass.intervals",
    statement: "You can read bass clef notes by the distance from the note before.",
  },
  {
    nodeId: "read.minor.accidentals",
    statement: "You can read the raised sixth and seventh in minor keys on the bass clef.",
  },
  {
    nodeId: "read.treble.landmarks",
    statement: "You can find the treble clef landmarks, middle C, G and high C, on the keyboard.",
  },
  {
    nodeId: "read.treble.steps",
    statement: "You can read treble clef notes one step from a landmark.",
  },
  {
    nodeId: "read.treble.skips",
    statement: "You can read the treble clef from middle C up to the A above high C.",
  },
  {
    nodeId: "read.grand.2line",
    statement:
      "You can read a short line on both staves in the key of the day and play it hands together.",
  },
  {
    nodeId: "read.grand.sight",
    statement: "You can sight-read a short passage for both hands at a steady pulse.",
  },
  {
    nodeId: "apply.pieces",
    statement: "You can read a short piece from the staff and play its phrases.",
  },
  {
    nodeId: "apply.piece-ear",
    statement: "You can learn a short tune by ear, then play it from memory.",
  },
];

/**
 * Enabled nodes that deliberately have no statement, with the reason. Empty: every implemented
 * node has one. A new generator ships with its statement, or lands here with a reason.
 */
export const MILESTONE_EXEMPT: Readonly<Record<string, string>> = {};

/** Parse raw milestone documents. Throws with the index and path on schema failure. */
export function parseMilestones(raw: readonly unknown[]): Milestone[] {
  return raw.map((doc, i) => {
    const result = MilestoneSchema.safeParse(doc);
    if (!result.success) {
      const lines = result.error.issues.map(
        (x) => `  ${x.path.join(".") || "(root)"}: ${x.message}`,
      );
      throw new Error(`Invalid milestone at index ${String(i)}:\n${lines.join("\n")}`);
    }
    return result.data;
  });
}

let loaded: Milestone[] | undefined;

/** All v1 capability milestones (spec 14). */
export function loadMilestones(): readonly Milestone[] {
  loaded ??= parseMilestones(MILESTONES_V1);
  return loaded;
}

export function milestoneForNode(nodeId: string): Milestone | undefined {
  return loadMilestones().find((m) => m.nodeId === nodeId);
}
