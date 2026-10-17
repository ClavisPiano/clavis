import type {
  Duration,
  ScoreNote,
  ScoreRest,
  ScoreSpec,
  SpelledPitch,
  StaffSpec,
  Step,
  WrittenAccidental,
} from "@clavis/core";

/*
 * MEI 5 generation for Verovio (T3.3). Pure: no clock, no randomness, no DOM.
 *
 * Decisions:
 * - A note's `xml:id` is its ScoreNote.id. A chord (pitches.length > 1) is a `<chord xml:id=id>` that
 *   carries dur/dots, with one child `<note>` per pitch whose id is derived as `${id}-${index + 1}`
 *   (n3 gives n3-1, n3-2). Core ids match /^n[0-9]+$/, so a derived id never collides with a real one.
 *   Highlighting by the chord id therefore reaches the whole chord.
 * - Ties go on the child notes (never on the chord element), because Verovio resolves note ties.
 * - A written accidental becomes `accid`. With none written, a sounding alteration becomes the gestural
 *   `accid.ges` (the key signature, or an earlier accidental in the bar, implies it).
 * - The key signature is computed here from the tonic and mode (no runtime core import).
 * - A percussion staff is `lines="1"` with `clef.shape="perc"`.
 * - A grand staff (two staves, treble over bass) is one `staffGrp` with `symbol="brace"` and
 *   `bar.thru="true"`. A single staff's `staffGrp` has no attributes.
 */

const MEI_NS = "http://www.music-encoding.org/ns/mei";

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/** Escapes text and attribute values. */
function esc(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (c) => XML_ESCAPES[c] ?? c);
}

type Attrs = readonly (readonly [string, string | number | undefined])[];

function attrs(list: Attrs): string {
  let out = "";
  for (const [name, value] of list) if (value !== undefined) out += ` ${name}="${esc(value)}"`;
  return out;
}

/** Position on the circle of fifths of each natural note name (F is -1, C is 0, G is 1, ...). */
const LETTER_FIFTHS: Record<string, number> = { F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5 };

/** Sharps (positive) or flats (negative) in the key signature. Throws for keys beyond 7 accidentals. */
export function keySignatureFifths(key: { tonic: string; mode: "major" | "minor" }): number {
  const m = /^([A-Ga-g])(#{0,2}|b{0,2})$/.exec(key.tonic);
  const letter = m?.[1]?.toUpperCase();
  const base = letter === undefined ? undefined : LETTER_FIFTHS[letter];
  if (m === null || base === undefined) {
    throw new Error(`toMei: unsupported key tonic "${key.tonic}"`);
  }
  const acc = m[2] ?? "";
  const alteration = acc.startsWith("#") ? acc.length : -acc.length;
  // A minor key has the signature of its relative major, three fifths down.
  const fifths = base + 7 * alteration - (key.mode === "minor" ? 3 : 0);
  if (fifths < -7 || fifths > 7) {
    throw new Error(`toMei: key ${key.tonic} ${key.mode} needs more than 7 accidentals`);
  }
  return fifths;
}

/** MEI `keysig` value: "0", "1s".."7s", "1f".."7f". */
function keysig(fifths: number): string {
  if (fifths === 0) return "0";
  return `${String(Math.abs(fifths))}${fifths > 0 ? "s" : "f"}`;
}

const WRITTEN_ACCID: Record<WrittenAccidental, string> = {
  sharp: "s",
  flat: "f",
  natural: "n",
  "double-sharp": "ss",
  "double-flat": "ff",
};

const GESTURAL_ACCID: Record<number, string> = { [-2]: "ff", [-1]: "f", 1: "s", 2: "ss" };

const TIE = { start: "i", continue: "m", stop: "t" } as const;

const CLEFS: Record<StaffSpec["clef"], { shape: string; line?: number }> = {
  bass: { shape: "F", line: 4 },
  treble: { shape: "G", line: 2 },
  percussion: { shape: "perc" },
};

const pnameOf = (step: Step): string => step.toLowerCase();

const dotsOf = (d: Duration): number | undefined => (d.dots === 1 ? 1 : undefined);

function noteAttrs(
  id: string,
  pitch: SpelledPitch,
  written: WrittenAccidental | undefined,
  tie: Duration["tie"],
  duration: Duration | undefined,
): string {
  return attrs([
    ["xml:id", id],
    ["pname", pnameOf(pitch.step)],
    ["oct", pitch.octave],
    ["dur", duration?.value],
    ["dots", duration === undefined ? undefined : dotsOf(duration)],
    ["accid", written === undefined ? undefined : WRITTEN_ACCID[written]],
    ["accid.ges", written === undefined ? GESTURAL_ACCID[pitch.alter] : undefined],
    ["tie", tie === undefined ? undefined : TIE[tie]],
  ]);
}

function noteXml(el: ScoreNote, pad: string): string {
  const [first, ...rest] = el.pitches;
  if (first === undefined) throw new Error(`toMei: note ${el.id} has no pitches`);
  if (rest.length === 0) {
    return `${pad}<note${noteAttrs(el.id, first, el.accidental, el.duration.tie, el.duration)}/>\n`;
  }
  const open = attrs([
    ["xml:id", el.id],
    ["dur", el.duration.value],
    ["dots", dotsOf(el.duration)],
  ]);
  let out = `${pad}<chord${open}>\n`;
  el.pitches.forEach((p, i) => {
    // The written accidental belongs to the whole ScoreNote; for a chord it is attached to the
    // first pitch. The others rely on the key signature or `accid.ges`.
    const written = i === 0 ? el.accidental : undefined;
    out += `${pad}  <note${noteAttrs(`${el.id}-${String(i + 1)}`, p, written, el.duration.tie, undefined)}/>\n`;
  });
  return `${out}${pad}</chord>\n`;
}

function restXml(el: ScoreRest, pad: string): string {
  return `${pad}<rest${attrs([
    ["dur", el.duration.value],
    ["dots", dotsOf(el.duration)],
  ])}/>\n`;
}

/** Converts a ScoreSpec to an MEI 5.0 document that Verovio can render. */
export function toMei(score: ScoreSpec): string {
  const scoreDefAttrs: Attrs = [
    ["keysig", score.key === null ? undefined : keysig(keySignatureFifths(score.key))],
    ["meter.count", score.meter?.beats],
    ["meter.unit", score.meter?.beatValue],
  ];

  let out = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  out += `<mei xmlns="${MEI_NS}" meiversion="5.0">\n`;
  out += `  <meiHead>\n    <fileDesc>\n      <titleStmt>\n        <title/>\n      </titleStmt>\n      <pubStmt/>\n    </fileDesc>\n  </meiHead>\n`;
  out += `  <music>\n    <body>\n      <mdiv>\n        <score>\n`;
  // A grand staff (R27) is joined by a brace, with bar lines drawn through both staves.
  const grand = score.staves.length > 1;
  const staffGrpAttrs: Attrs = [
    ["symbol", grand ? "brace" : undefined],
    ["bar.thru", grand ? "true" : undefined],
  ];
  out += `          <scoreDef${attrs(scoreDefAttrs)}>\n            <staffGrp${attrs(staffGrpAttrs)}>\n`;
  score.staves.forEach((staff, i) => {
    const clef = CLEFS[staff.clef];
    out += `              <staffDef${attrs([
      ["n", i + 1],
      ["lines", staff.lines],
      ["clef.shape", clef.shape],
      ["clef.line", clef.line],
    ])}/>\n`;
  });
  out += `            </staffGrp>\n          </scoreDef>\n          <section>\n`;

  const measureCount = Math.max(0, ...score.staves.map((s) => s.measures.length));
  for (let m = 0; m < measureCount; m++) {
    out += `            <measure n="${String(m + 1)}">\n`;
    score.staves.forEach((staff, i) => {
      out += `              <staff n="${String(i + 1)}">\n                <layer n="1">\n`;
      for (const el of staff.measures[m] ?? []) {
        const pad = "                  ";
        out += el.kind === "note" ? noteXml(el, pad) : restXml(el, pad);
      }
      out += `                </layer>\n              </staff>\n`;
    });
    out += `            </measure>\n`;
  }
  out += `          </section>\n        </score>\n      </mdiv>\n    </body>\n  </music>\n</mei>\n`;
  return out;
}
