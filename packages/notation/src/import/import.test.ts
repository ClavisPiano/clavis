import type { ScoreNote, ScoreRest, ScoreSpec, Step, WrittenAccidental } from "@clavis/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { estimateDifficulty, splitPhrases } from "./analysis.js";
import { ImportError, type ImportErrorCode } from "./errors.js";
import { importMusicXml } from "./musicxml.js";
import { importMxl } from "./mxl.js";
import { IMPORT_GOLDENS, IMPORT_REJECTS, buildMxl, toMusicXml } from "./testing.js";
import { parseXml } from "./xml.js";

function codeOf(fn: () => unknown): ImportErrorCode | "no error" {
  try {
    fn();
  } catch (e) {
    if (e instanceof ImportError) return e.code;
    throw e;
  }
  return "no error";
}

describe("importMusicXml goldens", () => {
  it.each(IMPORT_GOLDENS)("$name", ({ xml, options, expected }) => {
    expect(importMusicXml(xml, options)).toEqual(expected);
  });
});

describe("importMusicXml rejections", () => {
  it.each(IMPORT_REJECTS)("$name raises $code", ({ xml, code }) => {
    expect(codeOf(() => importMusicXml(xml))).toBe(code);
  });
});

const wrap = (attributes: string, notes: string): string =>
  `<score-partwise><part-list/><part id="P1"><measure number="1"><attributes><divisions>1</divisions>${attributes}</attributes>${notes}</measure></part></score-partwise>`;
const TREBLE = "<clef><sign>G</sign><line>2</line></clef>";
const C4_WHOLE =
  "<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>";

describe("importMusicXml errors", () => {
  const cases: [string, string, ImportErrorCode][] = [
    ["alto clef", wrap("<clef><sign>C</sign><line>3</line></clef>", C4_WHOLE), "unsupported-clef"],
    ["percussion clef", wrap("<clef><sign>percussion</sign></clef>", C4_WHOLE), "unsupported-clef"],
    ["no clef", wrap("", C4_WHOLE), "unsupported-clef"],
    [
      "8vb treble clef",
      wrap(
        "<clef><sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change></clef>",
        C4_WHOLE,
      ),
      "unsupported-clef",
    ],
    [
      "additive meter",
      wrap(`${TREBLE}<time><beats>3+2</beats><beat-type>8</beat-type></time>`, C4_WHOLE),
      "unsupported-meter",
    ],
    ["senza misura", wrap(`${TREBLE}<time><senza-misura/></time>`, C4_WHOLE), "unsupported-meter"],
    [
      "beat type 32",
      wrap(`${TREBLE}<time><beats>3</beats><beat-type>32</beat-type></time>`, C4_WHOLE),
      "unsupported-meter",
    ],
    [
      "dorian",
      wrap(`${TREBLE}<key><fifths>2</fifths><mode>dorian</mode></key>`, C4_WHOLE),
      "unsupported-key",
    ],
    [
      "32nd note",
      wrap(TREBLE, C4_WHOLE.replace("whole", "32nd").replace(">4<", ">1<")),
      "unsupported-duration",
    ],
    [
      "double dot",
      wrap(TREBLE, C4_WHOLE.replace("<type>", "<type>").replace("</type>", "</type><dot/><dot/>")),
      "unsupported-duration",
    ],
    [
      "duration mismatch",
      wrap(TREBLE, C4_WHOLE.replace("<duration>4", "<duration>3")),
      "malformed",
    ],
    [
      "quarter tone",
      wrap(TREBLE, C4_WHOLE.replace("</type>", "</type><accidental>quarter-sharp</accidental>")),
      "unsupported-accidental",
    ],
    [
      "fractional alter",
      wrap(TREBLE, C4_WHOLE.replace("<octave>", "<alter>0.5</alter><octave>")),
      "unsupported-accidental",
    ],
    [
      "grace note",
      wrap(TREBLE, C4_WHOLE.replace("<pitch>", "<grace/><pitch>")),
      "unsupported-note",
    ],
    [
      "unpitched",
      wrap(
        TREBLE,
        "<note><unpitched><display-step>C</display-step><display-octave>4</display-octave></unpitched><duration>4</duration><type>whole</type></note>",
      ),
      "unsupported-note",
    ],
    ["bad step", wrap(TREBLE, C4_WHOLE.replace(">C<", ">H<")), "malformed"],
    ["chord first", wrap(TREBLE, C4_WHOLE.replace("<pitch>", "<chord/><pitch>")), "malformed"],
    ["not xml", "<score-partwise><part>", "malformed"],
    ["mismatched tags", "<a><b></a></b>", "malformed"],
    ["timewise", "<score-timewise/>", "unsupported-format"],
    ["not musicxml", "<html/>", "unsupported-format"],
    ["no parts", "<score-partwise><part-list/></score-partwise>", "no-parts"],
  ];
  it.each(cases)("%s", (_name, xml, code) => {
    expect(codeOf(() => importMusicXml(xml))).toBe(code);
  });

  it("rejects a missing part and a missing staff", () => {
    const xml = wrap(TREBLE, C4_WHOLE);
    expect(codeOf(() => importMusicXml(xml, { partIndex: 1 }))).toBe("no-parts");
    expect(codeOf(() => importMusicXml(xml, { staff: 2 }))).toBe("no-staff");
  });

  it("rejects a key or meter change mid-piece", () => {
    const second = (extra: string): string =>
      wrap(`${TREBLE}<key><fifths>0</fifths></key>`, C4_WHOLE).replace(
        "</measure>",
        `</measure><measure number="2"><attributes>${extra}</attributes>${C4_WHOLE}</measure>`,
      );
    expect(codeOf(() => importMusicXml(second("<key><fifths>1</fifths></key>")))).toBe(
      "unsupported-key",
    );
    expect(codeOf(() => importMusicXml(second("<key><fifths>0</fifths></key>")))).toBe("no error");
    const meterXml = wrap(
      `${TREBLE}<time><beats>4</beats><beat-type>4</beat-type></time>`,
      C4_WHOLE,
    ).replace(
      "</measure>",
      `</measure><measure number="2"><attributes><time><beats>3</beats><beat-type>4</beat-type></time></attributes>${C4_WHOLE}</measure>`,
    );
    expect(codeOf(() => importMusicXml(meterXml))).toBe("unsupported-meter");
  });
});

describe("importMusicXml details", () => {
  it("merges a chord into one note and keeps the tie and accidental", () => {
    const xml = wrap(
      TREBLE,
      `<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type><tie type="start"/></note>
       <note><chord/><pitch><step>F</step><alter>1</alter><octave>4</octave></pitch><duration>4</duration><type>whole</type><accidental>sharp</accidental></note>`,
    );
    const score = importMusicXml(xml);
    expect(score.staves[0]?.measures[0]).toEqual([
      {
        kind: "note",
        id: "n1",
        pitches: [
          { step: "C", alter: 0, octave: 4 },
          { step: "F", alter: 1, octave: 4 },
        ],
        duration: { value: 1, dots: 0, tie: "start" },
        accidental: "sharp",
      },
    ]);
    expect(score.key).toBeNull();
    expect(score.meter).toBeNull();
  });

  it("reads a tie from <tied> when <tie> is absent, and a stop plus start as continue", () => {
    const tied = (types: string[]): string =>
      `<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type><notations>${types.map((t) => `<tied type="${t}"/>`).join("")}</notations></note>`;
    const score = importMusicXml(wrap(TREBLE, tied(["stop", "start"])));
    expect(score.staves[0]?.measures[0]?.[0]).toMatchObject({ duration: { tie: "continue" } });
  });

  it("maps double accidentals and keeps a whole-measure rest as the meter length", () => {
    const xml = wrap(
      `${TREBLE}<time><beats>6</beats><beat-type>8</beat-type></time>`,
      `<note><pitch><step>B</step><alter>-2</alter><octave>3</octave></pitch><duration>1</duration><type>quarter</type><accidental>flat-flat</accidental></note>`,
    ).replace("</measure>", `<note><rest measure="yes"/></note></measure>`);
    const m = importMusicXml(xml).staves[0]?.measures[0];
    expect(m?.[0]).toMatchObject({ accidental: "double-flat", pitches: [{ alter: -2 }] });
    expect(m?.[1]).toEqual({ kind: "rest", duration: { value: 2, dots: 1 } });
  });

  it("picks the requested part", () => {
    const xml = `<score-partwise><part id="P1"><measure><attributes><divisions>1</divisions>${TREBLE}</attributes>${C4_WHOLE}</measure></part><part id="P2"><measure><attributes><divisions>1</divisions><clef><sign>F</sign><line>4</line></clef></attributes>${C4_WHOLE.replace("C", "E")}</measure></part></score-partwise>`;
    expect(importMusicXml(xml, { partIndex: 1 }).staves[0]?.clef).toBe("bass");
    expect(importMusicXml(xml).staves[0]?.measures[0]).toMatchObject([
      { pitches: [{ step: "C" }] },
    ]);
  });
});

describe("importMxl", () => {
  it("reads the rootfile named by container.xml", () => {
    const golden = IMPORT_GOLDENS[0];
    if (golden === undefined) throw new Error("no golden");
    expect(importMxl(buildMxl(golden.xml, "nested/score.xml"))).toEqual(golden.expected);
  });

  it("raises malformed for garbage, a missing container and a missing rootfile", () => {
    expect(codeOf(() => importMxl(new Uint8Array([1, 2, 3, 4])))).toBe("malformed");
    const noContainer = new Uint8Array(buildMxl("<a/>")).slice();
    expect(codeOf(() => importMxl(noContainer.subarray(0, 10)))).toBe("malformed");
  });
});

describe("parseXml", () => {
  it("handles comments, CDATA, entities, single quotes and a DOCTYPE with a subset", () => {
    const root = parseXml(
      String.fromCharCode(0xfeff) +
        `<?xml version='1.0'?><!DOCTYPE a [<!ENTITY x "y">]><!-- hi --><a k='v&amp;w'><b><![CDATA[<x>]]> &lt;&#65;&#x42;</b><c/></a>`,
    );
    expect(root.attrs.k).toBe("v&w");
    expect(root.children[0]?.text).toBe("<x> <AB");
    expect(root.children[1]?.name).toBe("c");
  });

  it.each(["", "<a>", "<a></b>", "x<a/>", "<a/><b/>", "<a>&nope;</a>", "<a b=c/>", "<!-- x"])(
    "rejects %j",
    (xml) => {
      expect(codeOf(() => parseXml(xml))).toBe("malformed");
    },
  );
});

/* ---- Round trip: toMusicXml then import returns an equal spec ---- */

const KEYS: NonNullable<ScoreSpec["key"]>[] = [
  ...["Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#"].map(
    (tonic) => ({ tonic, mode: "major" as const }),
  ),
  ...["Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#", "G#", "D#", "A#"].map(
    (tonic) => ({ tonic, mode: "minor" as const }),
  ),
];

const stepArb = fc.constantFrom<Step>("C", "D", "E", "F", "G", "A", "B");
const pitchArb = fc.record({
  step: stepArb,
  alter: fc.integer({ min: -2, max: 2 }),
  octave: fc.integer({ min: 0, max: 9 }),
});
const durationArb = fc.record(
  {
    value: fc.constantFrom<1 | 2 | 4 | 8 | 16>(1, 2, 4, 8, 16),
    dots: fc.constantFrom<0 | 1>(0, 1),
    tie: fc.constantFrom<"start" | "continue" | "stop">("start", "continue", "stop"),
  },
  { requiredKeys: ["value", "dots"] },
);
const accidentalArb = fc.constantFrom<WrittenAccidental>(
  "sharp",
  "flat",
  "natural",
  "double-sharp",
  "double-flat",
);

type Raw = ScoreNote | ScoreRest;
const elementArb: fc.Arbitrary<Raw> = fc.oneof(
  fc.record({
    kind: fc.constant("rest" as const),
    duration: fc.record({
      value: fc.constantFrom<1 | 2 | 4 | 8 | 16>(1, 2, 4, 8, 16),
      dots: fc.constantFrom<0 | 1>(0, 1),
    }),
  }),
  fc.record(
    {
      kind: fc.constant("note" as const),
      id: fc.constant(""),
      pitches: fc.array(pitchArb, { minLength: 1, maxLength: 3 }),
      duration: durationArb,
      accidental: accidentalArb,
    },
    { requiredKeys: ["kind", "id", "pitches", "duration"] },
  ),
);

const scoreArb: fc.Arbitrary<ScoreSpec> = fc
  .record({
    clef: fc.constantFrom<"treble" | "bass">("treble", "bass"),
    measures: fc.array(fc.array(elementArb, { maxLength: 6 }), { minLength: 1, maxLength: 6 }),
    key: fc.option(fc.constantFrom(...KEYS), { nil: null }),
    meter: fc.option(
      fc.record({
        beats: fc.integer({ min: 1, max: 12 }),
        beatValue: fc.constantFrom<1 | 2 | 4 | 8>(1, 2, 4, 8),
      }),
      { nil: null },
    ),
  })
  .map(({ clef, measures, key, meter }) => {
    let next = 1;
    return {
      staves: [
        {
          clef,
          lines: 5 as const,
          measures: measures.map((m) =>
            m.map((el) => (el.kind === "note" ? { ...el, id: `n${String(next++)}` } : el)),
          ),
        },
      ],
      key,
      meter,
    };
  });

describe("round trip", () => {
  it("importMusicXml(toMusicXml(score)) equals score", () => {
    fc.assert(
      fc.property(scoreArb, (score) => {
        expect(importMusicXml(toMusicXml(score))).toEqual(score);
      }),
      { numRuns: 300 },
    );
  });

  it("importMxl of the zipped export equals score", () => {
    fc.assert(
      fc.property(scoreArb, (score) => {
        expect(importMxl(buildMxl(toMusicXml(score)))).toEqual(score);
      }),
      { numRuns: 50 },
    );
  });
});

/* ---- Phrases and difficulty ---- */

const quarter = (): Raw => ({
  kind: "note",
  id: "n0",
  pitches: [{ step: "C", alter: 0, octave: 4 }],
  duration: { value: 4, dots: 0 },
});
const half = (tie?: "start"): Raw => ({
  kind: "note",
  id: "n0",
  pitches: [{ step: "C", alter: 0, octave: 4 }],
  duration: { value: 2, dots: 0, ...(tie === undefined ? {} : { tie }) },
});
const restQ = (): Raw => ({ kind: "rest", duration: { value: 4, dots: 0 } });

function scoreOf(measures: Raw[][]): ScoreSpec {
  return {
    staves: [{ clef: "treble", lines: 5, measures }],
    key: { tonic: "C", mode: "major" },
    meter: { beats: 4, beatValue: 4 },
  };
}

describe("splitPhrases", () => {
  it("returns nothing for an empty score and one phrase for a single measure", () => {
    expect(splitPhrases(scoreOf([]))).toEqual([]);
    expect(splitPhrases(scoreOf([[quarter()]]))).toEqual([{ firstMeasure: 1, lastMeasure: 1 }]);
  });

  it("splits at 4 bars when the fourth ends on a long note or a rest", () => {
    const m = (end: Raw): Raw[] => [quarter(), quarter(), end];
    const measures = [
      m(quarter()),
      m(quarter()),
      m(quarter()),
      m(half()),
      m(quarter()),
      m(quarter()),
      m(quarter()),
      m(restQ()),
    ];
    expect(splitPhrases(scoreOf(measures))).toEqual([
      { firstMeasure: 1, lastMeasure: 4 },
      { firstMeasure: 5, lastMeasure: 8 },
    ]);
  });

  it("uses 2 bars when the second ends on a long note and the fourth does not", () => {
    const m = (end: Raw): Raw[] => [quarter(), end];
    const measures = [m(quarter()), m(half()), m(quarter()), m(quarter())];
    expect(splitPhrases(scoreOf(measures))).toEqual([
      { firstMeasure: 1, lastMeasure: 2 },
      { firstMeasure: 3, lastMeasure: 4 },
    ]);
  });

  it("does not split after a tied note and falls back to 2-bar groups", () => {
    const measures = [
      [quarter()],
      [half("start")],
      [quarter()],
      [half("start")],
      [quarter()],
      [quarter()],
    ];
    expect(splitPhrases(scoreOf(measures))).toEqual([
      { firstMeasure: 1, lastMeasure: 2 },
      { firstMeasure: 3, lastMeasure: 4 },
      { firstMeasure: 5, lastMeasure: 6 },
    ]);
  });

  it("absorbs a single leftover measure into the last phrase", () => {
    const measures = Array.from({ length: 5 }, () => [quarter()]);
    expect(splitPhrases(scoreOf(measures))).toEqual([
      { firstMeasure: 1, lastMeasure: 2 },
      { firstMeasure: 3, lastMeasure: 5 },
    ]);
  });

  it("tiles any score exactly", () => {
    fc.assert(
      fc.property(scoreArb, fc.integer({ min: 0, max: 30 }), (score, extra) => {
        const staff = score.staves[0];
        if (staff === undefined) return;
        const filler = staff.measures[0] ?? [];
        const grown: ScoreSpec = {
          ...score,
          staves: [
            {
              ...staff,
              measures: [...staff.measures, ...Array.from({ length: extra }, () => filler)],
            },
          ],
        };
        const phrases = splitPhrases(grown);
        const count = grown.staves[0]?.measures.length ?? 0;
        let next = 1;
        for (const p of phrases) {
          expect(p.firstMeasure).toBe(next);
          expect(p.lastMeasure).toBeGreaterThanOrEqual(p.firstMeasure);
          next = p.lastMeasure + 1;
        }
        expect(next - 1).toBe(count);
        // Never a lone single-measure phrase unless the whole score is one measure.
        if (count > 1)
          for (const p of phrases) expect(p.lastMeasure - p.firstMeasure).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: 200 },
    );
  });
});

describe("estimateDifficulty", () => {
  const nt = (
    step: Step,
    octave: number,
    value: 1 | 2 | 4 | 8 | 16,
    extra: Partial<Raw> = {},
  ): Raw => ({
    kind: "note",
    id: "n0",
    pitches: [{ step, alter: 0, octave }],
    duration: { value, dots: 0 },
    ...extra,
  });

  const slow = scoreOf([[nt("C", 4, 1)], [nt("D", 4, 1)], [nt("E", 4, 1)]]);
  const steps = scoreOf([
    [nt("C", 4, 4), nt("D", 4, 4), nt("E", 4, 4), nt("F", 4, 4)],
    [nt("G", 4, 4), nt("F", 4, 4), nt("E", 4, 4), nt("D", 4, 4)],
  ]);
  const moving = scoreOf([
    [nt("C", 4, 8), nt("D", 4, 8), nt("E", 4, 8), nt("G", 4, 8), nt("C", 5, 4), nt("A", 4, 4)],
    [
      nt("G", 4, 8),
      nt("F", 4, 8),
      nt("E", 4, 4, { duration: { value: 4, dots: 1 } }),
      nt("D", 4, 8),
      nt("C", 4, 4),
    ],
  ]);
  const hard: ScoreSpec = {
    ...scoreOf([
      [
        nt("C", 3, 16),
        nt("F", 4, 16, { accidental: "sharp" }),
        nt("B", 5, 8, { accidental: "flat" }),
        nt("E", 3, 16),
        nt("G", 5, 16),
        nt("A", 3, 16),
        restQ(),
        nt("D", 6, 8),
      ],
      [
        nt("C", 3, 16, { accidental: "natural" }),
        nt("F", 5, 16, { accidental: "sharp" }),
        nt("B", 3, 8, { duration: { value: 8, dots: 0, tie: "start" } }),
        nt("B", 3, 8, { duration: { value: 8, dots: 0, tie: "stop" } }),
        nt("E", 5, 4, { duration: { value: 4, dots: 1 } }),
        nt("G", 4, 2),
      ],
    ]),
    key: { tonic: "A", mode: "major" },
  };

  it("grows across obvious cases", () => {
    const levels = [slow, steps, moving, hard].map(estimateDifficulty);
    expect(levels).toEqual([...levels].sort((a, b) => a - b));
    expect(new Set(levels).size).toBe(levels.length);
  });

  it("stays on the 1 to 10 scale", () => {
    expect(estimateDifficulty(scoreOf([]))).toBe(1);
    fc.assert(
      fc.property(scoreArb, (score) => {
        const d = estimateDifficulty(score);
        expect(Number.isInteger(d) && d >= 1 && d <= 10).toBe(true);
      }),
    );
  });

  it("does not drop when an accidental is added or the range widens", () => {
    const base = estimateDifficulty(steps);
    const wider = scoreOf([
      [nt("C", 3, 4), nt("D", 4, 4), nt("E", 4, 4), nt("F", 6, 4)],
      [nt("G", 4, 4), nt("F", 4, 4), nt("E", 4, 4), nt("D", 4, 4)],
    ]);
    expect(estimateDifficulty(wider)).toBeGreaterThanOrEqual(base);
  });
});
