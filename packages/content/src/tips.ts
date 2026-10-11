import type { AttemptError } from "@clavis/core";

/**
 * One-line concept explanations for feedback (spec 13, delivery point 2): when scoring names an
 * error pattern, say why in terms of the concept and link to the card that explains it.
 */
export interface ConceptTip {
  text: string;
}

export type TipMode = "major" | "minor";

/** What each degree feels like, by degree label (as produced by `degreeLabels`). */
const DEGREE_FEEL: Record<TipMode, Readonly<Record<string, string>>> = {
  major: {
    "1": "1 is home, settled and finished",
    "2": "2 is one step above home and wants to fall back to 1",
    "3": "3 is the bright middle of the home chord",
    "4": "4 leans down to 3",
    "5": "5 is the strong, open top of the home chord",
    "6": "6 is gentle and usually falls to 5",
    "7": "7 is a half step below home and pulls up to 1",
  },
  minor: {
    "1": "1 is home, settled and finished",
    "2": "2 is one step above home and wants to fall back to 1",
    "3": "3 is the dark middle of the minor home chord",
    "4": "4 leans down towards 3",
    "5": "5 is the strong, open top of the home chord",
    "6": "6 is a half step above 5 and sinks onto it",
    "7": "7 is the note just below home, leading back up to 1",
    "#7": "the raised 7 of harmonic minor is a half step below home and pulls up to 1",
  },
};

const RHYTHM_TIMING =
  "Count the beat under the rhythm: a note between two beats lands exactly halfway.";
const RHYTHM_EXTRA = "Listen for the silences too: a rest still takes up its beat.";
const RHYTHM_TEMPO =
  "Feel the beat under the rhythm and keep it steady. The gaps are measured against your own tempo.";
const SING_NONE =
  'Sing on an open vowel such as "ah", loud enough to be heard, and hold the note steady for about a second.';

const CONFUSION_PREFIX = "degree.confusion.";

function degreeTip(expected: string, played: string, mode: TipMode): ConceptTip | undefined {
  const e = DEGREE_FEEL[mode][expected];
  const p = DEGREE_FEEL[mode][played];
  if (e === undefined || p === undefined || expected === played) return undefined;
  return { text: `${capitalise(e)}, while ${p}.` };
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function tipFor(error: AttemptError, mode: TipMode): ConceptTip | undefined {
  const { code, detail } = error;
  if (code.startsWith(CONFUSION_PREFIX)) {
    const [expected, played] = code.slice(CONFUSION_PREFIX.length).split("-");
    if (expected === undefined || played === undefined) return undefined;
    return degreeTip(expected, played, mode);
  }
  switch (code) {
    case "sequence.wrong-note": {
      const expected = detail?.expectedDegree;
      const played = detail?.playedDegree;
      return typeof expected === "string" && typeof played === "string"
        ? degreeTip(expected, played, mode)
        : undefined;
    }
    case "rhythm.late":
    case "rhythm.early":
    case "rhythm.missed":
      return { text: RHYTHM_TIMING };
    case "rhythm.extra":
      return { text: RHYTHM_EXTRA };
    case "rhythm.tempo-drift":
      return { text: RHYTHM_TEMPO };
    case "sing.none":
      return { text: SING_NONE };
    default:
      return undefined;
  }
}

/**
 * The tip for the first error, in scoring's order, that has one. `mode` is the item's mode
 * (degree labels mean different notes in major and minor); rhythm items can pass "major".
 */
export function conceptTip(errors: readonly AttemptError[], mode: TipMode): ConceptTip | undefined {
  for (const e of errors) {
    const tip = tipFor(e, mode);
    if (tip) return tip;
  }
  return undefined;
}
