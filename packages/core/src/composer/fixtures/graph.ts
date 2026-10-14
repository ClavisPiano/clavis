import { at } from "../../theory/util.js";
import type { SkillGraph } from "../../graph/schema.js";

/*
 * Test fixture: a copy of the v1 content graph (packages/content/src/graph/v1.json) trimmed to
 * the EAR nodes plus one READ and one HANDS root. Core cannot import @clavis/content, so this
 * is copied by hand. Keep generator flags and EAR nodes in step with the content graph.
 */
export const V1_GRAPH: SkillGraph = {
  contentVersion: "2026.10.1",
  nodes: [
    {
      id: "ear.degrees.major.135",
      strand: "EAR",
      title: "Degrees 1, 3, 5",
      description: "Sing or play scale degrees 1, 3 and 5 after a cadence.",
      prerequisites: [],
      itemGenerators: ["degreeSing", "degreeId"],
      params: {
        mode: "major",
        degrees: [1, 3, 5],
      },
      mastery: {
        minAccuracy: 0.9,
        maxMedianLatencyMs: 1500,
        windowAttempts: 20,
        distinctSessions: 2,
      },
      keyDependent: false,
      targetLatencyMs: 1500,
    },
    {
      id: "ear.rhythm.echo",
      strand: "EAR",
      title: "Rhythm echo",
      description: "Hear a 1-2 bar rhythm and tap or play it back.",
      prerequisites: [],
      itemGenerators: ["rhythmEcho"],
      params: {
        bars: [1, 2],
        meter: "4/4",
      },
      mastery: {
        minAccuracy: 0.9,
        windowAttempts: 20,
        distinctSessions: 2,
      },
      keyDependent: false,
    },
    {
      id: "ear.degrees.major.diatonic",
      strand: "EAR",
      title: "All major degrees",
      description: "All seven major scale degrees as single notes.",
      prerequisites: ["ear.degrees.major.135"],
      itemGenerators: ["degreeSing", "degreeId"],
      params: {
        mode: "major",
        degrees: [1, 2, 3, 4, 5, 6, 7],
      },
      mastery: {
        minAccuracy: 0.9,
        maxMedianLatencyMs: 1500,
        windowAttempts: 20,
        distinctSessions: 2,
      },
      keyDependent: false,
      targetLatencyMs: 1500,
    },
    {
      id: "ear.cells.major.2-4",
      strand: "EAR",
      title: "Melodic cells",
      description: "Echo 2-4 note diatonic melodic cells.",
      prerequisites: ["ear.degrees.major.diatonic"],
      itemGenerators: ["cellEcho"],
      params: {
        mode: "major",
        minNotes: 2,
        maxNotes: 4,
        diatonic: true,
      },
      mastery: {
        minAccuracy: 0.9,
        maxMedianLatencyMs: 3000,
        windowAttempts: 20,
        distinctSessions: 2,
      },
      keyDependent: false,
      targetLatencyMs: 3000,
    },
    {
      id: "ear.bass.I-IV-V-vi",
      strand: "EAR",
      title: "Bass motion",
      description: "Identify the bass root motion between I, IV, V and vi.",
      prerequisites: ["ear.degrees.major.diatonic"],
      itemGenerators: ["bassMotion"],
      params: {
        mode: "major",
        chords: ["I", "IV", "V", "vi"],
      },
      mastery: {
        minAccuracy: 0.9,
        maxMedianLatencyMs: 4000,
        windowAttempts: 20,
        distinctSessions: 2,
      },
      keyDependent: false,
      targetLatencyMs: 4000,
    },
    {
      id: "ear.quality.triad",
      strand: "EAR",
      title: "Triad quality",
      description: "Hear major versus minor triads in context, then diminished.",
      prerequisites: ["ear.bass.I-IV-V-vi"],
      itemGenerators: ["chordQuality"],
      params: {
        qualities: ["major", "minor"],
        laterQualities: ["diminished"],
        roots: [1, 2, 3, 4, 5, 6],
      },
      mastery: {
        minAccuracy: 0.9,
        maxMedianLatencyMs: 2000,
        windowAttempts: 20,
        distinctSessions: 2,
      },
      keyDependent: false,
      targetLatencyMs: 2000,
    },
    {
      id: "ear.prog.core",
      strand: "EAR",
      title: "Core progressions",
      description: "Identify the four core pop and classical progressions.",
      prerequisites: ["ear.quality.triad"],
      itemGenerators: ["progressionId"],
      params: {
        mode: "major",
        progressions: [
          ["I", "V", "vi", "IV"],
          ["I", "IV", "V"],
          ["ii", "V", "I"],
          ["vi", "IV", "I", "V"],
        ],
      },
      mastery: {
        minAccuracy: 0.9,
        maxMedianLatencyMs: 3000,
        windowAttempts: 20,
        distinctSessions: 2,
      },
      keyDependent: false,
      targetLatencyMs: 3000,
    },
    {
      id: "ear.cadence",
      strand: "EAR",
      title: "Cadences",
      description: "Tell perfect, plagal, imperfect and deceptive cadences apart.",
      prerequisites: ["ear.prog.core"],
      itemGenerators: ["progressionId"],
      params: {
        mode: "major",
        cadences: {
          perfect: ["V", "I"],
          plagal: ["IV", "I"],
          imperfect: ["I", "V"],
          deceptive: ["V", "vi"],
        },
      },
      mastery: {
        minAccuracy: 0.9,
        maxMedianLatencyMs: 3000,
        windowAttempts: 20,
        distinctSessions: 2,
      },
      keyDependent: false,
      targetLatencyMs: 3000,
    },
    {
      id: "ear.degrees.minor",
      strand: "EAR",
      title: "Minor degrees",
      description: "Natural and harmonic minor scale degrees, heard from the minor tonic.",
      prerequisites: ["ear.cells.major.2-4"],
      itemGenerators: ["degreeSing", "degreeId"],
      params: {
        mode: "minor",
        variants: ["natural", "harmonic"],
        degrees: [1, 2, 3, 4, 5, 6, 7],
      },
      mastery: {
        minAccuracy: 0.9,
        maxMedianLatencyMs: 1500,
        windowAttempts: 20,
        distinctSessions: 2,
      },
      keyDependent: false,
      targetLatencyMs: 1500,
    },
    {
      id: "ear.prog.minor",
      strand: "EAR",
      title: "Minor progressions",
      description: "i-iv-v, i-VI-III-VII and the Andalusian cadence.",
      prerequisites: ["ear.degrees.minor", "ear.prog.core"],
      itemGenerators: ["progressionId"],
      params: {
        mode: "minor",
        progressions: [
          ["i", "iv", "v"],
          ["i", "VI", "III", "VII"],
          ["i", "VII", "VI", "V"],
        ],
      },
      mastery: {
        minAccuracy: 0.9,
        maxMedianLatencyMs: 3000,
        windowAttempts: 20,
        distinctSessions: 2,
      },
      keyDependent: false,
      targetLatencyMs: 3000,
    },
    {
      id: "ear.prog.colour",
      strand: "EAR",
      title: "Colour chords",
      description: "Secondary dominant V/V, borrowed iv and bVII.",
      prerequisites: ["ear.prog.minor"],
      itemGenerators: ["progressionId"],
      params: {
        mode: "major",
        progressions: [
          ["I", "V/V", "V", "I"],
          ["I", "IV", "iv", "I"],
          ["I", "bVII", "IV", "I"],
        ],
      },
      mastery: {
        minAccuracy: 0.9,
        maxMedianLatencyMs: 3000,
        windowAttempts: 20,
        distinctSessions: 2,
      },
      keyDependent: false,
      targetLatencyMs: 3000,
    },
    {
      id: "ear.real.phrase",
      strand: "EAR",
      title: "Real phrases",
      description: "Short phrases from real recordings.",
      prerequisites: ["ear.prog.core", "ear.cells.major.2-4"],
      itemGenerators: ["byEarPhrase"],
      params: {
        source: "recordings",
        bars: [2, 4],
        stages: ["melody"],
      },
      mastery: {
        minAccuracy: 0.8,
        windowAttempts: 10,
        distinctSessions: 2,
      },
      keyDependent: false,
    },
    {
      id: "read.bass.landmarks",
      strand: "READ",
      title: "Bass landmarks",
      description: "Bass staff landmarks: low C, F on the clef line, middle C, low G.",
      prerequisites: [],
      itemGenerators: ["bassNoteRead"],
      params: {
        clef: "bass",
        notes: ["C2", "F3", "C4", "G2"],
      },
      mastery: {
        minAccuracy: 0.9,
        maxMedianLatencyMs: 1200,
        windowAttempts: 20,
        distinctSessions: 2,
      },
      keyDependent: true,
      targetLatencyMs: 1200,
    },
    {
      id: "hands.lh.triads.root",
      strand: "HANDS",
      title: "Root-position triads",
      description: "Left-hand root-position I, IV, V and vi in key.",
      prerequisites: [],
      itemGenerators: ["lhPattern"],
      params: {
        pattern: "block",
        chords: ["I", "IV", "V", "vi"],
        inversion: "root",
      },
      mastery: {
        minAccuracy: 0.8,
        windowAttempts: 5,
        distinctSessions: 2,
      },
      keyDependent: true,
    },
  ],
  generators: [
    {
      id: "degreeSing",
      implemented: true,
      seedDurationSec: 8,
      awayEligible: true,
      requires: ["mic", "keys"],
    },
    {
      id: "degreeId",
      implemented: true,
      seedDurationSec: 6,
      awayEligible: true,
      requires: ["keys"],
    },
    {
      id: "cellEcho",
      implemented: true,
      seedDurationSec: 12,
      awayEligible: true,
      requires: ["mic", "keys"],
    },
    {
      id: "rhythmEcho",
      implemented: true,
      seedDurationSec: 12,
      awayEligible: true,
      requires: ["keys"],
    },
    {
      id: "rhythmRead",
      implemented: false,
      seedDurationSec: 12,
      awayEligible: false,
      requires: ["keys", "notation"],
    },
    {
      id: "bassMotion",
      implemented: false,
      seedDurationSec: 15,
      awayEligible: true,
      requires: ["keys"],
    },
    {
      id: "chordQuality",
      implemented: false,
      seedDurationSec: 8,
      awayEligible: true,
      requires: ["keys"],
    },
    {
      id: "progressionId",
      implemented: false,
      seedDurationSec: 15,
      awayEligible: true,
      requires: ["keys"],
    },
    {
      id: "bassNoteRead",
      implemented: false,
      seedDurationSec: 5,
      awayEligible: true,
      requires: ["keys", "notation"],
    },
    {
      id: "bassChordRead",
      implemented: false,
      seedDurationSec: 8,
      awayEligible: false,
      requires: ["keys", "polyphonic", "notation"],
    },
    {
      id: "sightLine",
      implemented: false,
      seedDurationSec: 60,
      awayEligible: false,
      requires: ["keys", "polyphonic", "notation"],
    },
    {
      id: "lhPattern",
      implemented: false,
      seedDurationSec: 90,
      awayEligible: false,
      requires: ["keys", "polyphonic"],
    },
    {
      id: "coordTask",
      implemented: false,
      seedDurationSec: 90,
      awayEligible: false,
      requires: ["keys", "polyphonic", "notation"],
    },
    {
      id: "byEarPhrase",
      implemented: false,
      seedDurationSec: 180,
      awayEligible: false,
      requires: ["mic", "keys", "polyphonic"],
    },
    {
      id: "concept",
      implemented: false,
      seedDurationSec: 30,
      awayEligible: true,
      requires: [],
    },
  ],
};

export const HANDS_ROOT = "hands.lh.triads.root";
export const HANDS_EAR = "ear.test.handsdep";

/**
 * v1 plus one synthetic EAR node that sits behind a HANDS node, which the real graph does not
 * have yet. With `singAway` false, `degreeSing` is not Away eligible.
 */
export function withHandsDependentEar(singAway = true): SkillGraph {
  const proto = at(V1_GRAPH.nodes, 0);
  return {
    ...V1_GRAPH,
    generators: V1_GRAPH.generators.map((g) =>
      g.id === "degreeSing" ? { ...g, awayEligible: singAway } : g,
    ),
    nodes: [
      ...V1_GRAPH.nodes,
      {
        ...proto,
        id: HANDS_EAR,
        prerequisites: [HANDS_ROOT],
        itemGenerators: ["degreeId"],
        params: { mode: "major", degrees: [1, 2, 3, 4] },
      },
    ],
  };
}
