import type { Duration, ScoreNote, ScoreRest, ScoreSpec, Step } from "../score/schema.js";

/*
 * Authoring helper for the piece library: a one-staff line written bar by bar as text, so a melody
 * can be checked against the printed tune by eye. Natural notes only (the library is in C major);
 * a sharp or flat is rejected until a piece needs one.
 *
 *   "E4q D4q C4h"   note: step letter, octave, duration letter, optional "." for a dot
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

export interface LineSpec {
  clef: "treble" | "bass";
  key: { tonic: string; mode: "major" | "minor" };
  meter: { beats: number; beatValue: 1 | 2 | 4 | 8 };
  /** One string per measure. */
  bars: readonly string[];
}

export function line(spec: LineSpec): ScoreSpec {
  let n = 0;
  const measures = spec.bars.map((bar) =>
    bar
      .trim()
      .split(/\s+/)
      .map((token): ScoreNote | ScoreRest => {
        if (token.startsWith("r")) {
          return { kind: "rest", duration: parseDuration(token.slice(1), token) };
        }
        const m = /^([A-G])([0-9])(.+)$/.exec(token);
        if (m === null || !STEPS.has(m[1] ?? "")) throw new Error(`bad note "${token}"`);
        n += 1;
        return {
          kind: "note",
          id: `n${String(n)}`,
          pitches: [{ step: m[1] as Step, alter: 0, octave: Number(m[2]) }],
          duration: parseDuration(m[3] ?? "", token),
        };
      }),
  );
  return {
    staves: [{ clef: spec.clef, lines: 5, measures }],
    key: spec.key,
    meter: spec.meter,
  };
}
