import type { ScoreNote, ScoreRest, ScoreSpec, WrittenAccidental } from "@clavis/core";
import { zipSync, strToU8 } from "fflate";
import type { ImportOptions } from "./musicxml.js";

/*
 * Test support for the importer, exported as `@clavis/notation/testing` so the web app's tests can
 * validate the results against the core zod schema (notation itself may not import core at runtime).
 * Nothing here is used by the app. It holds hand-written MusicXML fixtures with their golden
 * ScoreSpecs, an MXL builder, and `toMusicXml`, the inverse of the importer for property tests.
 */

const note = (
  id: string,
  step: ScoreNote["pitches"][number]["step"],
  alter: number,
  octave: number,
  value: ScoreNote["duration"]["value"],
  extra: { dots?: 0 | 1; tie?: "start" | "continue" | "stop"; accidental?: WrittenAccidental } = {},
): ScoreNote => ({
  kind: "note",
  id,
  pitches: [{ step, alter, octave }],
  duration: {
    value,
    dots: extra.dots ?? 0,
    ...(extra.tie === undefined ? {} : { tie: extra.tie }),
  },
  ...(extra.accidental === undefined ? {} : { accidental: extra.accidental }),
});

const rest = (value: ScoreRest["duration"]["value"]): ScoreRest => ({
  kind: "rest",
  duration: { value, dots: 0 },
});

const HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">`;
const TAIL = `  </part>
</score-partwise>
`;

const n = (
  step: string,
  octave: number,
  type: string,
  duration: number,
  more = "",
  alter?: number,
  staff = 1,
): string =>
  `<note><pitch><step>${step}</step>${alter === undefined ? "" : `<alter>${String(alter)}</alter>`}<octave>${String(octave)}</octave></pitch><duration>${String(duration)}</duration><voice>${String(staff)}</voice><type>${type}</type>${more}<staff>${String(staff)}</staff></note>`;

const r = (type: string, duration: number, staff = 1, more = ""): string =>
  `<note><rest/><duration>${String(duration)}</duration><voice>${String(staff)}</voice><type>${type}</type>${more}<staff>${String(staff)}</staff></note>`;

/** G major, 4/4, treble. A tie across the barline, a dotted quarter, an implied F sharp, a rest. */
const TREBLE_G_MAJOR = `${HEAD}
    <measure number="1">
      <attributes><divisions>2</divisions><key><fifths>1</fifths><mode>major</mode></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      ${n("G", 4, "quarter", 2)}${n("A", 4, "quarter", 2)}${n("B", 4, "quarter", 3, "<dot/>")}${n("C", 5, "eighth", 1)}
    </measure>
    <measure number="2">
      ${n("D", 5, "half", 4, '<tie type="start"/>')}${n("D", 5, "quarter", 2, '<tie type="stop"/>')}${r("quarter", 2)}
    </measure>
    <measure number="3">
      ${n("F", 5, "half", 4, "", 1)}${n("G", 5, "half", 4)}
    </measure>
${TAIL}`;

const TREBLE_G_MAJOR_SPEC: ScoreSpec = {
  staves: [
    {
      clef: "treble",
      lines: 5,
      measures: [
        [
          note("n1", "G", 0, 4, 4),
          note("n2", "A", 0, 4, 4),
          note("n3", "B", 0, 4, 4, { dots: 1 }),
          note("n4", "C", 0, 5, 8),
        ],
        [
          note("n5", "D", 0, 5, 2, { tie: "start" }),
          note("n6", "D", 0, 5, 4, { tie: "stop" }),
          rest(4),
        ],
        [note("n7", "F", 1, 5, 2), note("n8", "G", 0, 5, 2)],
      ],
    },
  ],
  key: { tonic: "G", mode: "major" },
  meter: { beats: 4, beatValue: 4 },
};

/** A grand-staff piano part. Staff 2 is a bass line in D minor, 3/4, with a written C sharp. */
const PIANO_D_MINOR = `${HEAD}
    <measure number="1">
      <attributes><divisions>1</divisions><key><fifths>-1</fifths><mode>minor</mode></key><time><beats>3</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>
      ${n("D", 5, "half", 3, "<dot/>")}
      <backup><duration>3</duration></backup>
      ${n("D", 3, "quarter", 1, "", undefined, 2)}${n("E", 3, "quarter", 1, "", undefined, 2)}${n("F", 3, "quarter", 1, "", undefined, 2)}
    </measure>
    <measure number="2">
      ${r("half", 3, 1, "<dot/>")}
      <backup><duration>3</duration></backup>
      ${n("C", 3, "half", 2, "<accidental>sharp</accidental>", 1, 2)}${n("D", 3, "quarter", 1, "", undefined, 2)}
    </measure>
    <measure number="3">
      <note><rest measure="yes"/><duration>3</duration><staff>1</staff></note>
      <backup><duration>3</duration></backup>
      ${n("D", 3, "half", 3, "<dot/>", undefined, 2)}
    </measure>
${TAIL}`;

const PIANO_D_MINOR_BASS_SPEC: ScoreSpec = {
  staves: [
    {
      clef: "bass",
      lines: 5,
      measures: [
        [note("n1", "D", 0, 3, 4), note("n2", "E", 0, 3, 4), note("n3", "F", 0, 3, 4)],
        [note("n4", "C", 1, 3, 2, { accidental: "sharp" }), note("n5", "D", 0, 3, 4)],
        [note("n6", "D", 0, 3, 2, { dots: 1 })],
      ],
    },
  ],
  key: { tonic: "D", mode: "minor" },
  meter: { beats: 3, beatValue: 4 },
};

const PIANO_D_MINOR_TREBLE_SPEC: ScoreSpec = {
  staves: [
    {
      clef: "treble",
      lines: 5,
      measures: [
        [note("n1", "D", 0, 5, 2, { dots: 1 })],
        [{ kind: "rest", duration: { value: 2, dots: 1 } }],
        [{ kind: "rest", duration: { value: 2, dots: 1 } }],
      ],
    },
  ],
  key: { tonic: "D", mode: "minor" },
  meter: { beats: 3, beatValue: 4 },
};

/** Two voices on one staff. */
const TWO_VOICES = `${HEAD}
    <measure number="1">
      <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type></note>
      <backup><duration>4</duration></backup>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>2</voice><type>whole</type></note>
    </measure>
${TAIL}`;

/** An eighth-note triplet. */
const TRIPLET = `${HEAD}
    <measure number="1">
      <attributes><divisions>3</divisions><time><beats>1</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><type>eighth</type><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><type>eighth</type><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><type>eighth</type><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification></note>
    </measure>
${TAIL}`;

export interface MusicXmlFixture {
  name: string;
  xml: string;
  options?: ImportOptions;
  expected: ScoreSpec;
}

/** Fixtures the importer must turn into exactly `expected`. */
export const IMPORT_GOLDENS: readonly MusicXmlFixture[] = [
  { name: "treble G major", xml: TREBLE_G_MAJOR, expected: TREBLE_G_MAJOR_SPEC },
  {
    name: "piano staff 2 (bass, D minor)",
    xml: PIANO_D_MINOR,
    options: { staff: 2 },
    expected: PIANO_D_MINOR_BASS_SPEC,
  },
  {
    name: "piano staff 1 (treble, D minor)",
    xml: PIANO_D_MINOR,
    expected: PIANO_D_MINOR_TREBLE_SPEC,
  },
];

/** Fixtures the importer must refuse, with the error code. */
export const IMPORT_REJECTS = [
  { name: "two voices", xml: TWO_VOICES, code: "multiple-voices" },
  { name: "tuplet", xml: TRIPLET, code: "tuplets" },
] as const;

/** Wraps a score file in an MXL (zip) container with a `META-INF/container.xml` rootfile. */
export function buildMxl(xml: string, path = "score.musicxml"): Uint8Array {
  const container = `<?xml version="1.0" encoding="UTF-8"?>
<container><rootfiles><rootfile full-path="${path}" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>
`;
  return zipSync({
    "META-INF/container.xml": strToU8(container),
    [path]: strToU8(xml),
  });
}

/* ---- toMusicXml: the inverse of the importer, for round-trip property tests ---- */

/** Divisions per quarter note used by `toMusicXml`: a dotted 16th is 3 divisions. */
const DIVISIONS = 8;

const TYPE_NAMES = { 1: "whole", 2: "half", 4: "quarter", 8: "eighth", 16: "16th" } as const;

const ACCIDENTAL_NAMES: Record<WrittenAccidental, string> = {
  sharp: "sharp",
  flat: "flat",
  natural: "natural",
  "double-sharp": "double-sharp",
  "double-flat": "flat-flat",
};

const MAJOR_FIFTHS: Record<string, number> = {
  Cb: -7,
  Gb: -6,
  Db: -5,
  Ab: -4,
  Eb: -3,
  Bb: -2,
  F: -1,
  C: 0,
  G: 1,
  D: 2,
  A: 3,
  E: 4,
  B: 5,
  "F#": 6,
  "C#": 7,
};
const MINOR_FIFTHS: Record<string, number> = {
  Ab: -7,
  Eb: -6,
  Bb: -5,
  F: -4,
  C: -3,
  G: -2,
  D: -1,
  A: 0,
  E: 1,
  B: 2,
  "F#": 3,
  "C#": 4,
  "G#": 5,
  "D#": 6,
  "A#": 7,
};

function divisionsOf(d: { value: 1 | 2 | 4 | 8 | 16; dots: 0 | 1 }): number {
  const base = (DIVISIONS * 4) / d.value;
  return d.dots === 1 ? (base * 3) / 2 : base;
}

/** Serialises a single-staff ScoreSpec (treble or bass) as partwise MusicXML. Test support only. */
export function toMusicXml(score: ScoreSpec): string {
  const staff = score.staves[0];
  if (staff === undefined || staff.clef === "percussion") {
    throw new Error("toMusicXml: needs one pitched staff");
  }
  let attributes = `<divisions>${String(DIVISIONS)}</divisions>`;
  if (score.key !== null) {
    const table = score.key.mode === "major" ? MAJOR_FIFTHS : MINOR_FIFTHS;
    const fifths = table[score.key.tonic];
    if (fifths === undefined) throw new Error(`toMusicXml: unknown key ${score.key.tonic}`);
    attributes += `<key><fifths>${String(fifths)}</fifths><mode>${score.key.mode}</mode></key>`;
  }
  if (score.meter !== null) {
    attributes += `<time><beats>${String(score.meter.beats)}</beats><beat-type>${String(score.meter.beatValue)}</beat-type></time>`;
  }
  attributes +=
    staff.clef === "treble"
      ? "<clef><sign>G</sign><line>2</line></clef>"
      : "<clef><sign>F</sign><line>4</line></clef>";

  const tieXml = (tie: "start" | "continue" | "stop" | undefined): [string, string] => {
    if (tie === undefined) return ["", ""];
    const types = tie === "continue" ? ["stop", "start"] : [tie];
    return [
      types.map((t) => `<tie type="${t}"/>`).join(""),
      `<notations>${types.map((t) => `<tied type="${t}"/>`).join("")}</notations>`,
    ];
  };

  let body = "";
  staff.measures.forEach((measure, m) => {
    body += `<measure number="${String(m + 1)}">${m === 0 ? `<attributes>${attributes}</attributes>` : ""}`;
    for (const el of measure) {
      const d = el.duration;
      const common = `<duration>${String(divisionsOf(d))}</duration>`;
      const dots = d.dots === 1 ? "<dot/>" : "";
      if (el.kind === "rest") {
        body += `<note><rest/>${common}<voice>1</voice><type>${TYPE_NAMES[d.value]}</type>${dots}</note>`;
        continue;
      }
      const [tie, tied] = tieXml(d.tie);
      el.pitches.forEach((p, i) => {
        const accidental =
          i === 0 && el.accidental !== undefined
            ? `<accidental>${ACCIDENTAL_NAMES[el.accidental]}</accidental>`
            : "";
        body += `<note>${i === 0 ? "" : "<chord/>"}<pitch><step>${p.step}</step>${p.alter === 0 ? "" : `<alter>${String(p.alter)}</alter>`}<octave>${String(p.octave)}</octave></pitch>${common}${tie}<voice>1</voice><type>${TYPE_NAMES[d.value]}</type>${dots}${accidental}${tied}</note>`;
      });
    }
    body += "</measure>";
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Test</part-name></score-part></part-list><part id="P1">${body}</part></score-partwise>
`;
}
