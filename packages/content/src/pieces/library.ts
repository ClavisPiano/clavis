import { PieceSchema, line, type Piece } from "@clavis/core";

/*
 * The MP library: nine short public-domain tunes for one hand, easiest first, right hand then left.
 * Each tune is typed in by hand from the melody itself (no engraving or edition is copied); the
 * provenance of every piece is in docs/licences.md.
 *
 * Required nodes are the reading nodes that cover every pitch of the piece (checked against the
 * graph in the tests). Every treble tune sits in the C position, and E4 first appears in
 * `read.treble.skips`, so they all need the whole treble chain. The bass tunes sit an octave lower
 * (C position, C3 to G3) and need the whole bass chain.
 */

const C_MAJOR = { tonic: "C", mode: "major" } as const;
const FOUR_FOUR = { beats: 4, beatValue: 4 } as const;

const TREBLE_NODES = ["read.treble.landmarks", "read.treble.steps", "read.treble.skips"];
const BASS_NODES = ["read.bass.landmarks", "read.bass.steps", "read.bass.skips"];

const HOT_CROSS_BUNS = [
  "E4q D4q C4h",
  "E4q D4q C4h",
  "C4e C4e C4e C4e D4e D4e D4e D4e",
  "E4q D4q C4h",
];

const ODE_TO_JOY = [
  "E4q E4q F4q G4q",
  "G4q F4q E4q D4q",
  "C4q C4q D4q E4q",
  "E4q. D4e D4h",
  "E4q E4q F4q G4q",
  "G4q F4q E4q D4q",
  "C4q C4q D4q E4q",
  "D4q. C4e C4h",
];

const MARY = [
  "E4q D4q C4q D4q",
  "E4q E4q E4h",
  "D4q D4q D4h",
  "E4q G4q G4h",
  "E4q D4q C4q D4q",
  "E4q E4q E4q E4q",
  "D4q D4q E4q D4q",
  "C4w",
];

const AU_CLAIR = ["C4q C4q C4q D4q", "E4h D4h", "C4q E4q D4q D4q", "C4w"];

const TWINKLE = [
  "C4q C4q G4q G4q",
  "A4q A4q G4h",
  "F4q F4q E4q E4q",
  "D4q D4q C4h",
  "G4q G4q F4q F4q",
  "E4q E4q D4h",
  "G4q G4q F4q F4q",
  "E4q E4q D4h",
  "C4q C4q G4q G4q",
  "A4q A4q G4h",
  "F4q F4q E4q E4q",
  "D4q D4q C4h",
];

const FRERE_JACQUES = [
  "C4q D4q E4q C4q",
  "C4q D4q E4q C4q",
  "E4q F4q G4h",
  "E4q F4q G4h",
  "G4e A4e G4e F4e E4q C4q",
  "G4e A4e G4e F4e E4q C4q",
  "C4q G3q C4h",
  "C4q G3q C4h",
];

/** The same tune an octave lower, for the bass clef. */
function down(bars: readonly string[]): string[] {
  return bars.map((bar) =>
    bar.replace(
      /\b([A-G])([0-9])/g,
      (_, step: string, oct: string) => `${step}${String(Number(oct) - 1)}`,
    ),
  );
}

const RAW: Piece[] = [
  {
    id: "piece.hot-cross-buns",
    title: "Hot Cross Buns",
    source: "Traditional",
    score: line({ clef: "treble", key: C_MAJOR, meter: FOUR_FOUR, bars: HOT_CROSS_BUNS }),
    phrases: [
      { firstMeasure: 1, lastMeasure: 2 },
      { firstMeasure: 3, lastMeasure: 4 },
    ],
    requiredNodeIds: TREBLE_NODES,
    difficulty: 1,
  },
  {
    id: "piece.ode-to-joy",
    title: "Ode to Joy",
    source: "Ludwig van Beethoven (Symphony No. 9)",
    score: line({ clef: "treble", key: C_MAJOR, meter: FOUR_FOUR, bars: ODE_TO_JOY }),
    phrases: [
      { firstMeasure: 1, lastMeasure: 2 },
      { firstMeasure: 3, lastMeasure: 4 },
      { firstMeasure: 5, lastMeasure: 6 },
      { firstMeasure: 7, lastMeasure: 8 },
    ],
    requiredNodeIds: TREBLE_NODES,
    difficulty: 2,
  },
  {
    id: "piece.mary-had-a-little-lamb",
    title: "Mary Had a Little Lamb",
    source: "Traditional",
    score: line({ clef: "treble", key: C_MAJOR, meter: FOUR_FOUR, bars: MARY }),
    phrases: [
      { firstMeasure: 1, lastMeasure: 2 },
      { firstMeasure: 3, lastMeasure: 4 },
      { firstMeasure: 5, lastMeasure: 6 },
      { firstMeasure: 7, lastMeasure: 8 },
    ],
    requiredNodeIds: TREBLE_NODES,
    difficulty: 3,
  },
  {
    id: "piece.au-clair-de-la-lune",
    title: "Au clair de la lune",
    source: "Traditional (French)",
    score: line({ clef: "treble", key: C_MAJOR, meter: FOUR_FOUR, bars: AU_CLAIR }),
    phrases: [
      { firstMeasure: 1, lastMeasure: 2 },
      { firstMeasure: 3, lastMeasure: 4 },
    ],
    requiredNodeIds: TREBLE_NODES,
    difficulty: 3,
  },
  {
    id: "piece.twinkle-twinkle",
    title: "Twinkle, Twinkle, Little Star",
    source: "Traditional (French, Ah! vous dirai-je, maman)",
    score: line({ clef: "treble", key: C_MAJOR, meter: FOUR_FOUR, bars: TWINKLE }),
    phrases: [
      { firstMeasure: 1, lastMeasure: 2 },
      { firstMeasure: 3, lastMeasure: 4 },
      { firstMeasure: 5, lastMeasure: 6 },
      { firstMeasure: 7, lastMeasure: 8 },
      { firstMeasure: 9, lastMeasure: 10 },
      { firstMeasure: 11, lastMeasure: 12 },
    ],
    requiredNodeIds: TREBLE_NODES,
    difficulty: 4,
  },
  {
    id: "piece.mary-had-a-little-lamb-lh",
    title: "Mary Had a Little Lamb (left hand)",
    source: "Traditional",
    score: line({ clef: "bass", key: C_MAJOR, meter: FOUR_FOUR, bars: down(MARY) }),
    phrases: [
      { firstMeasure: 1, lastMeasure: 2 },
      { firstMeasure: 3, lastMeasure: 4 },
      { firstMeasure: 5, lastMeasure: 6 },
      { firstMeasure: 7, lastMeasure: 8 },
    ],
    requiredNodeIds: BASS_NODES,
    difficulty: 5,
  },
  {
    id: "piece.ode-to-joy-lh",
    title: "Ode to Joy (left hand)",
    source: "Ludwig van Beethoven (Symphony No. 9)",
    score: line({ clef: "bass", key: C_MAJOR, meter: FOUR_FOUR, bars: down(ODE_TO_JOY) }),
    phrases: [
      { firstMeasure: 1, lastMeasure: 2 },
      { firstMeasure: 3, lastMeasure: 4 },
      { firstMeasure: 5, lastMeasure: 6 },
      { firstMeasure: 7, lastMeasure: 8 },
    ],
    requiredNodeIds: BASS_NODES,
    difficulty: 6,
  },
  {
    id: "piece.twinkle-twinkle-lh",
    title: "Twinkle, Twinkle, Little Star (left hand)",
    source: "Traditional (French, Ah! vous dirai-je, maman)",
    score: line({ clef: "bass", key: C_MAJOR, meter: FOUR_FOUR, bars: down(TWINKLE) }),
    phrases: [
      { firstMeasure: 1, lastMeasure: 2 },
      { firstMeasure: 3, lastMeasure: 4 },
      { firstMeasure: 5, lastMeasure: 6 },
      { firstMeasure: 7, lastMeasure: 8 },
      { firstMeasure: 9, lastMeasure: 10 },
      { firstMeasure: 11, lastMeasure: 12 },
    ],
    requiredNodeIds: BASS_NODES,
    difficulty: 7,
  },
  {
    id: "piece.frere-jacques-lh",
    title: "Frère Jacques (left hand)",
    source: "Traditional (French)",
    score: line({ clef: "bass", key: C_MAJOR, meter: FOUR_FOUR, bars: down(FRERE_JACQUES) }),
    phrases: [
      { firstMeasure: 1, lastMeasure: 2 },
      { firstMeasure: 3, lastMeasure: 4 },
      { firstMeasure: 5, lastMeasure: 6 },
      { firstMeasure: 7, lastMeasure: 8 },
    ],
    requiredNodeIds: BASS_NODES,
    difficulty: 8,
  },
];

/** Parse every piece through the schema so a mistake in the library fails at load, not in a session. */
export function loadPieces(): Piece[] {
  return RAW.map((p) => PieceSchema.parse(p));
}
