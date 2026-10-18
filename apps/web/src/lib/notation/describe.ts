import type { ScoreNote, ScoreRest, ScoreSpec } from "@clavis/core";

type ScoreElementLike = ScoreNote | ScoreRest;

/*
 * T8.2: a spoken description of a displayed score, for screen readers. With `pitches: false` it
 * says only what is on the page around the notes (clefs, key, meter, how many bars and notes), so
 * a reading item's answer is not given away. With `pitches: true` it lists every note, which suits
 * the worked examples on concept cards and the preview of an imported piece.
 */

const DURATION_WORDS: Record<number, string> = {
  1: "whole",
  2: "half",
  4: "quarter",
  8: "eighth",
  16: "sixteenth",
};

const ALTER_WORDS: Record<number, string> = {
  [-2]: " double flat",
  [-1]: " flat",
  0: "",
  1: " sharp",
  2: " double sharp",
};

const CLEF_WORDS = { bass: "Bass clef", treble: "Treble clef", percussion: "Rhythm line" } as const;

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${String(n)} ${n === 1 ? one : many}`;

function pitchWords(p: { step: string; alter: number; octave: number }): string {
  return `${p.step}${ALTER_WORDS[p.alter] ?? ""} ${String(p.octave)}`;
}

function durationWords(d: { value: number; dots: number; tie?: string | undefined }): string {
  const base = `${d.dots === 1 ? "dotted " : ""}${DURATION_WORDS[d.value] ?? String(d.value)}`;
  return d.tie === "start" || d.tie === "continue" ? `${base}, tied to the next` : base;
}

function elementWords(el: ScoreElementLike): string {
  if (el.kind === "rest") return `${durationWords(el.duration)} rest`;
  const pitches = el.pitches.map(pitchWords);
  const what = pitches.length === 1 ? pitches.join("") : `chord of ${pitches.join(", ")}`;
  return `${what}, ${durationWords(el.duration)}`;
}

function keyWords(score: ScoreSpec): string {
  return score.key === null ? "no key" : `${score.key.tonic} ${score.key.mode}`;
}

function meterWords(score: ScoreSpec): string {
  return score.meter === null
    ? "no time signature"
    : `${String(score.meter.beats)}/${String(score.meter.beatValue)} time`;
}

/** The description. Never throws; an empty score still gets a sentence. */
export function describeScore(score: ScoreSpec, options: { pitches: boolean }): string {
  const staves = score.staves;
  const bars = Math.max(0, ...staves.map((s) => s.measures.length));
  const clefs = staves.map((s) => CLEF_WORDS[s.clef]).join(" and ");
  const head = `${clefs}, ${keyWords(score)}, ${meterWords(score)}, ${plural(bars, "bar")}.`;
  if (!options.pitches) {
    const notes = staves.reduce(
      (n, s) => n + s.measures.flat().filter((el) => el.kind === "note").length,
      0,
    );
    return `${head} ${plural(notes, "note")}.`;
  }
  // Hands are only named for a real grand staff; any other pair of staves is just "Staff 1", "Staff 2".
  const grandStaff =
    staves.length === 2 && staves[0]?.clef === "treble" && staves[1]?.clef === "bass";
  const lines = staves.map((staff, i) => {
    const name = grandStaff ? (i === 0 ? "Right hand" : "Left hand") : `Staff ${String(i + 1)}`;
    const label = staves.length === 1 ? "" : `${name}. `;
    const body = staff.measures
      .map(
        (m, b) =>
          `Bar ${String(b + 1)}: ${m.length === 0 ? "empty" : m.map(elementWords).join("; ")}.`,
      )
      .join(" ");
    return `${label}${body}`;
  });
  return `${head} ${lines.join(" ")}`;
}
