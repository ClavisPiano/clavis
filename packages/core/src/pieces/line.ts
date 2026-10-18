import type {
  Duration,
  ScoreNote,
  ScoreRest,
  ScoreSpec,
  SpelledPitch,
  StaffSpec,
  Step,
} from "../score/schema.js";

/*
 * Authoring helper for the piece library: a one-staff line written bar by bar as text, so a melody
 * can be checked against the printed tune by eye. Natural notes only (the library is in C major);
 * a sharp or flat is rejected until a piece needs one.
 *
 *   "E4q D4q C4h"   note: step letter, octave, duration letter, optional "." for a dot
 *   "C3+E3+G3w"     chord: pitches joined by "+", the duration after the last one
 *   "rq"            rest: "r" then a duration letter
 *
 * Durations: w whole, h half, q quarter, e eighth, s sixteenth.
 */

const VALUES: Record<string, Duration["value"]> = { w: 1, h: 2, q: 4, e: 8, s: 16 };
const STEPS = new Set<string>(["C", "D", "E", "F", "G", "A", "B"]);

function parseDuration(code: string, token: string): Duration {
  const dotted = code.endsWith(".");
  const value = VALUES[dotted ? code.slice(0, -1) : code];
  if (value === undefined) throw new Error(`bad duration in "${token}"`);
  return { value, dots: dotted ? 1 : 0 };
}

function parsePitch(text: string, token: string): SpelledPitch {
  const m = /^([A-G])([0-9])$/.exec(text);
  if (m === null || !STEPS.has(m[1] ?? "")) throw new Error(`bad note "${token}"`);
  return { step: m[1] as Step, alter: 0, octave: Number(m[2]) };
}

export interface LineSpec {
  clef: "treble" | "bass";
  key: { tonic: string; mode: "major" | "minor" };
  meter: { beats: number; beatValue: 1 | 2 | 4 | 8 };
  /** One string per measure. */
  bars: readonly string[];
}

/** The measures of `bars` on one staff. Note ids go on from `first` (n1 when it is 1). */
function staffOf(clef: LineSpec["clef"], bars: readonly string[], first: number): StaffSpec {
  let n = first - 1;
  const measures = bars.map((bar) =>
    bar
      .trim()
      .split(/\s+/)
      .map((token): ScoreNote | ScoreRest => {
        if (token.startsWith("r")) {
          return { kind: "rest", duration: parseDuration(token.slice(1), token) };
        }
        const parts = token.split("+");
        const last = parts.pop() ?? "";
        const m = /^([A-G][0-9])(.+)$/.exec(last);
        if (m === null) throw new Error(`bad note "${token}"`);
        const pitches = [...parts, m[1] ?? ""].map((p) => parsePitch(p, token));
        n += 1;
        return {
          kind: "note",
          id: `n${String(n)}`,
          pitches,
          duration: parseDuration(m[2] ?? "", token),
        };
      }),
  );
  return { clef, lines: 5, measures };
}

export function line(spec: LineSpec): ScoreSpec {
  return {
    staves: [staffOf(spec.clef, spec.bars, 1)],
    key: spec.key,
    meter: spec.meter,
  };
}

export interface GrandStaffSpec {
  key: LineSpec["key"];
  meter: LineSpec["meter"];
  /** The right hand, one string per measure. */
  treble: readonly string[];
  /** The left hand, one string per measure. */
  bass: readonly string[];
}

/**
 * A grand staff (R27): treble then bass. The treble ids are the ones `line` gives the same bars,
 * and the bass ids go on from the last treble one, so ids stay unique across the score.
 */
export function grandStaff(spec: GrandStaffSpec): ScoreSpec {
  const treble = staffOf("treble", spec.treble, 1);
  const count = treble.measures.flat().filter((el) => el.kind === "note").length;
  return {
    staves: [treble, staffOf("bass", spec.bass, count + 1)],
    key: spec.key,
    meter: spec.meter,
  };
}
