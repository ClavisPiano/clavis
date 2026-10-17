import type { ScoreNote, ScoreSpec } from "./schema.js";

/** Golden score specs. Used by schema tests and by notation renderers' tests. */

function note(
  id: string,
  step: "C" | "D" | "E" | "F" | "G" | "A" | "B",
  alter: number,
  octave: number,
  duration: ScoreNote["duration"],
  accidental?: ScoreNote["accidental"],
): ScoreNote {
  return {
    kind: "note",
    id,
    pitches: [{ step, alter, octave }],
    duration,
    ...(accidental === undefined ? {} : { accidental }),
  };
}

/** Whole note F3 on the bass staff in G major. Sounds F#3; the key signature implies it, so no accidental is written. */
export const FIXTURE_BASS_F3_G_MAJOR: ScoreSpec = {
  staves: [{ clef: "bass", lines: 5, measures: [[note("n1", "F", 1, 3, { value: 1, dots: 0 })]] }],
  key: { tonic: "G", mode: "major" },
  meter: null,
};

/** Raised 7th of D minor: C#3 with a written sharp, since the key signature has only B flat. */
export const FIXTURE_D_MINOR_RAISED_7TH: ScoreSpec = {
  staves: [
    {
      clef: "bass",
      lines: 5,
      measures: [[note("n1", "C", 1, 3, { value: 1, dots: 0 }, "sharp")]],
    },
  ],
  key: { tonic: "D", mode: "minor" },
  meter: null,
};

/** Interval pair in C major: C3 then G3 (n1, n2). */
export const FIXTURE_INTERVAL_C3_G3: ScoreSpec = {
  staves: [
    {
      clef: "bass",
      lines: 5,
      measures: [
        [
          note("n1", "C", 0, 3, { value: 2, dots: 0 }),
          note("n2", "G", 0, 3, { value: 2, dots: 0 }),
        ],
      ],
    },
  ],
  key: { tonic: "C", mode: "major" },
  meter: null,
};

/** One-line percussion rhythm in 4/4 over 2 bars: a dotted quarter, and a tie across the barline. */
export const FIXTURE_PERCUSSION_RHYTHM: ScoreSpec = {
  staves: [
    {
      clef: "percussion",
      lines: 1,
      measures: [
        [
          note("n1", "B", 0, 4, { value: 4, dots: 1 }),
          note("n2", "B", 0, 4, { value: 8, dots: 0 }),
          note("n3", "B", 0, 4, { value: 4, dots: 0 }),
          note("n4", "B", 0, 4, { value: 4, dots: 0, tie: "start" }),
        ],
        [
          note("n5", "B", 0, 4, { value: 2, dots: 0, tie: "stop" }),
          { kind: "rest", duration: { value: 2, dots: 0 } },
        ],
      ],
    },
  ],
  key: null,
  meter: { beats: 4, beatValue: 4 },
};

/**
 * A grand staff in G major, 4/4, two bars (R27). Treble: B4 A4 G4 A4, then a half G4 and a half
 * rest. Bass: a whole G major triad (n6), then D3, a quarter rest and a half G2. Ids run on across
 * the staves.
 */
export const FIXTURE_GRAND_STAFF: ScoreSpec = {
  staves: [
    {
      clef: "treble",
      lines: 5,
      measures: [
        [
          note("n1", "B", 0, 4, { value: 4, dots: 0 }),
          note("n2", "A", 0, 4, { value: 4, dots: 0 }),
          note("n3", "G", 0, 4, { value: 4, dots: 0 }),
          note("n4", "A", 0, 4, { value: 4, dots: 0 }),
        ],
        [
          note("n5", "G", 0, 4, { value: 2, dots: 0 }),
          { kind: "rest", duration: { value: 2, dots: 0 } },
        ],
      ],
    },
    {
      clef: "bass",
      lines: 5,
      measures: [
        [
          {
            kind: "note",
            id: "n6",
            pitches: [
              { step: "G", alter: 0, octave: 2 },
              { step: "B", alter: 0, octave: 2 },
              { step: "D", alter: 0, octave: 3 },
            ],
            duration: { value: 1, dots: 0 },
          },
        ],
        [
          note("n7", "D", 0, 3, { value: 4, dots: 0 }),
          { kind: "rest", duration: { value: 4, dots: 0 } },
          note("n8", "G", 0, 2, { value: 2, dots: 0 }),
        ],
      ],
    },
  ],
  key: { tonic: "G", mode: "major" },
  meter: { beats: 4, beatValue: 4 },
};

export const SCORE_FIXTURES = {
  bassF3GMajor: FIXTURE_BASS_F3_G_MAJOR,
  dMinorRaised7th: FIXTURE_D_MINOR_RAISED_7TH,
  intervalC3G3: FIXTURE_INTERVAL_C3_G3,
  percussionRhythm: FIXTURE_PERCUSSION_RHYTHM,
  grandStaff: FIXTURE_GRAND_STAFF,
} as const;
