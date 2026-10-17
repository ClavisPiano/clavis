import type { ScoreNote, ScoreSpec, StaffSpec, Step } from "@clavis/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { keySignatureFifths, toMei } from "./mei.js";
import { findAll, parseXml } from "./xml-test-support.js";

// notation may only use `import type` from core, so the T3.1 fixtures are copied here as literals.
type Dur = ScoreNote["duration"];

function note(
  id: string,
  step: Step,
  alter: number,
  octave: number,
  duration: Dur,
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

const bassF3GMajor: ScoreSpec = {
  staves: [{ clef: "bass", lines: 5, measures: [[note("n1", "F", 1, 3, { value: 1, dots: 0 })]] }],
  key: { tonic: "G", mode: "major" },
  meter: null,
};

const dMinorRaised7th: ScoreSpec = {
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

const intervalC3G3: ScoreSpec = {
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

const percussionRhythm: ScoreSpec = {
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

/** Core's FIXTURE_GRAND_STAFF: G major, 4/4, treble over bass, ids running on across staves. */
const grandStaff: ScoreSpec = {
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

describe("toMei golden output", () => {
  it("bass F3 in G major: gestural sharp from the key signature", () => {
    expect(toMei(bassF3GMajor)).toMatchInlineSnapshot(`
      "<?xml version="1.0" encoding="UTF-8"?>
      <mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="5.0">
        <meiHead>
          <fileDesc>
            <titleStmt>
              <title/>
            </titleStmt>
            <pubStmt/>
          </fileDesc>
        </meiHead>
        <music>
          <body>
            <mdiv>
              <score>
                <scoreDef keysig="1s">
                  <staffGrp>
                    <staffDef n="1" lines="5" clef.shape="F" clef.line="4"/>
                  </staffGrp>
                </scoreDef>
                <section>
                  <measure n="1">
                    <staff n="1">
                      <layer n="1">
                        <note xml:id="n1" pname="f" oct="3" dur="1" accid.ges="s"/>
                      </layer>
                    </staff>
                  </measure>
                </section>
              </score>
            </mdiv>
          </body>
        </music>
      </mei>
      "
    `);
  });

  it("D minor raised 7th: written sharp, key signature of one flat", () => {
    expect(toMei(dMinorRaised7th)).toMatchInlineSnapshot(`
      "<?xml version="1.0" encoding="UTF-8"?>
      <mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="5.0">
        <meiHead>
          <fileDesc>
            <titleStmt>
              <title/>
            </titleStmt>
            <pubStmt/>
          </fileDesc>
        </meiHead>
        <music>
          <body>
            <mdiv>
              <score>
                <scoreDef keysig="1f">
                  <staffGrp>
                    <staffDef n="1" lines="5" clef.shape="F" clef.line="4"/>
                  </staffGrp>
                </scoreDef>
                <section>
                  <measure n="1">
                    <staff n="1">
                      <layer n="1">
                        <note xml:id="n1" pname="c" oct="3" dur="1" accid="s"/>
                      </layer>
                    </staff>
                  </measure>
                </section>
              </score>
            </mdiv>
          </body>
        </music>
      </mei>
      "
    `);
  });

  it("C3 to G3 interval in C major", () => {
    expect(toMei(intervalC3G3)).toMatchInlineSnapshot(`
      "<?xml version="1.0" encoding="UTF-8"?>
      <mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="5.0">
        <meiHead>
          <fileDesc>
            <titleStmt>
              <title/>
            </titleStmt>
            <pubStmt/>
          </fileDesc>
        </meiHead>
        <music>
          <body>
            <mdiv>
              <score>
                <scoreDef keysig="0">
                  <staffGrp>
                    <staffDef n="1" lines="5" clef.shape="F" clef.line="4"/>
                  </staffGrp>
                </scoreDef>
                <section>
                  <measure n="1">
                    <staff n="1">
                      <layer n="1">
                        <note xml:id="n1" pname="c" oct="3" dur="2"/>
                        <note xml:id="n2" pname="g" oct="3" dur="2"/>
                      </layer>
                    </staff>
                  </measure>
                </section>
              </score>
            </mdiv>
          </body>
        </music>
      </mei>
      "
    `);
  });

  it("two-bar percussion rhythm with a dotted quarter and a tie across the barline", () => {
    expect(toMei(percussionRhythm)).toMatchInlineSnapshot(`
      "<?xml version="1.0" encoding="UTF-8"?>
      <mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="5.0">
        <meiHead>
          <fileDesc>
            <titleStmt>
              <title/>
            </titleStmt>
            <pubStmt/>
          </fileDesc>
        </meiHead>
        <music>
          <body>
            <mdiv>
              <score>
                <scoreDef meter.count="4" meter.unit="4">
                  <staffGrp>
                    <staffDef n="1" lines="1" clef.shape="perc"/>
                  </staffGrp>
                </scoreDef>
                <section>
                  <measure n="1">
                    <staff n="1">
                      <layer n="1">
                        <note xml:id="n1" pname="b" oct="4" dur="4" dots="1"/>
                        <note xml:id="n2" pname="b" oct="4" dur="8"/>
                        <note xml:id="n3" pname="b" oct="4" dur="4"/>
                        <note xml:id="n4" pname="b" oct="4" dur="4" tie="i"/>
                      </layer>
                    </staff>
                  </measure>
                  <measure n="2">
                    <staff n="1">
                      <layer n="1">
                        <note xml:id="n5" pname="b" oct="4" dur="2" tie="t"/>
                        <rest dur="2"/>
                      </layer>
                    </staff>
                  </measure>
                </section>
              </score>
            </mdiv>
          </body>
        </music>
      </mei>
      "
    `);
  });
});

describe("toMei grand staff golden output (R27)", () => {
  it("treble over bass in one braced staffGrp, both staves in every measure", () => {
    expect(toMei(grandStaff)).toMatchInlineSnapshot(`
      "<?xml version="1.0" encoding="UTF-8"?>
      <mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="5.0">
        <meiHead>
          <fileDesc>
            <titleStmt>
              <title/>
            </titleStmt>
            <pubStmt/>
          </fileDesc>
        </meiHead>
        <music>
          <body>
            <mdiv>
              <score>
                <scoreDef keysig="1s" meter.count="4" meter.unit="4">
                  <staffGrp symbol="brace" bar.thru="true">
                    <staffDef n="1" lines="5" clef.shape="G" clef.line="2"/>
                    <staffDef n="2" lines="5" clef.shape="F" clef.line="4"/>
                  </staffGrp>
                </scoreDef>
                <section>
                  <measure n="1">
                    <staff n="1">
                      <layer n="1">
                        <note xml:id="n1" pname="b" oct="4" dur="4"/>
                        <note xml:id="n2" pname="a" oct="4" dur="4"/>
                        <note xml:id="n3" pname="g" oct="4" dur="4"/>
                        <note xml:id="n4" pname="a" oct="4" dur="4"/>
                      </layer>
                    </staff>
                    <staff n="2">
                      <layer n="1">
                        <chord xml:id="n6" dur="1">
                          <note xml:id="n6-1" pname="g" oct="2"/>
                          <note xml:id="n6-2" pname="b" oct="2"/>
                          <note xml:id="n6-3" pname="d" oct="3"/>
                        </chord>
                      </layer>
                    </staff>
                  </measure>
                  <measure n="2">
                    <staff n="1">
                      <layer n="1">
                        <note xml:id="n5" pname="g" oct="4" dur="2"/>
                        <rest dur="2"/>
                      </layer>
                    </staff>
                    <staff n="2">
                      <layer n="1">
                        <note xml:id="n7" pname="d" oct="3" dur="4"/>
                        <rest dur="4"/>
                        <note xml:id="n8" pname="g" oct="2" dur="2"/>
                      </layer>
                    </staff>
                  </measure>
                </section>
              </score>
            </mdiv>
          </body>
        </music>
      </mei>
      "
    `);
  });
});

describe("toMei details", () => {
  it.each([
    ["C", "major", "0"],
    ["G", "major", "1s"],
    ["F", "major", "1f"],
    ["Bb", "major", "2f"],
    ["F#", "major", "6s"],
    ["Cb", "major", "7f"],
    ["A", "minor", "0"],
    ["D", "minor", "1f"],
    ["E", "minor", "1s"],
    ["C#", "minor", "4s"],
    ["Eb", "minor", "6f"],
  ] as const)("%s %s has keysig %s", (tonic, mode, expected) => {
    const score: ScoreSpec = { ...intervalC3G3, key: { tonic, mode } };
    expect(toMei(score)).toContain(`keysig="${expected}"`);
  });

  it("rejects keys beyond seven accidentals and unknown tonics", () => {
    expect(() => keySignatureFifths({ tonic: "G#", mode: "major" })).toThrow();
    expect(() => keySignatureFifths({ tonic: "H", mode: "major" })).toThrow();
  });

  it("writes a chord with derived child ids, ties on the children", () => {
    const score: ScoreSpec = {
      staves: [
        {
          clef: "treble",
          lines: 5,
          measures: [
            [
              {
                kind: "note",
                id: "n3",
                pitches: [
                  { step: "C", alter: 0, octave: 4 },
                  { step: "E", alter: -1, octave: 4 },
                ],
                duration: { value: 1, dots: 0, tie: "start" },
                accidental: "flat",
              },
            ],
          ],
        },
      ],
      key: null,
      meter: null,
    };
    expect(toMei(score)).toMatchInlineSnapshot(`
      "<?xml version="1.0" encoding="UTF-8"?>
      <mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="5.0">
        <meiHead>
          <fileDesc>
            <titleStmt>
              <title/>
            </titleStmt>
            <pubStmt/>
          </fileDesc>
        </meiHead>
        <music>
          <body>
            <mdiv>
              <score>
                <scoreDef>
                  <staffGrp>
                    <staffDef n="1" lines="5" clef.shape="G" clef.line="2"/>
                  </staffGrp>
                </scoreDef>
                <section>
                  <measure n="1">
                    <staff n="1">
                      <layer n="1">
                        <chord xml:id="n3" dur="1">
                          <note xml:id="n3-1" pname="c" oct="4" accid="f" tie="i"/>
                          <note xml:id="n3-2" pname="e" oct="4" accid.ges="f" tie="i"/>
                        </chord>
                      </layer>
                    </staff>
                  </measure>
                </section>
              </score>
            </mdiv>
          </body>
        </music>
      </mei>
      "
    `);
  });

  it("escapes attribute values", () => {
    const score: ScoreSpec = {
      ...intervalC3G3,
      staves: [
        {
          clef: "bass",
          lines: 5,
          measures: [[note(`n1"<&>'`, "C", 0, 3, { value: 1, dots: 0 })]],
        },
      ],
    };
    const mei = toMei(score);
    expect(mei).toContain("n1&quot;&lt;&amp;&gt;&apos;");
    expect(findAll(parseXml(mei), "note")[0]?.attrs["xml:id"]).toBe(`n1"<&>'`);
  });
});

const STEPS: Step[] = ["C", "D", "E", "F", "G", "A", "B"];
const ACCIDENTALS = ["sharp", "flat", "natural", "double-sharp", "double-flat"] as const;
const TIES = ["start", "continue", "stop"] as const;

/** Duration options as [value, dots, length in sixteenths]. Dotted sixteenths are excluded. */
const DURATIONS: readonly (readonly [Dur["value"], Dur["dots"], number])[] = [
  [1, 0, 16],
  [2, 1, 12],
  [2, 0, 8],
  [4, 1, 6],
  [4, 0, 4],
  [8, 1, 3],
  [8, 0, 2],
  [16, 0, 1],
];

const pitchArb = fc.record({
  step: fc.constantFrom(...STEPS),
  alter: fc.integer({ min: -2, max: 2 }),
  octave: fc.integer({ min: 0, max: 9 }),
});

const slotArb = fc.record({
  pick: fc.nat(),
  rest: fc.boolean(),
  pitches: fc.array(pitchArb, { minLength: 1, maxLength: 3 }),
  accidental: fc.option(fc.constantFrom(...ACCIDENTALS), { nil: undefined }),
  tie: fc.option(fc.constantFrom(...TIES), { nil: undefined }),
});

const keyArb = fc.option(
  fc.record({
    tonic: fc.constantFrom("C", "G", "D", "A", "F", "Bb", "Eb", "E", "B", "F#"),
    mode: fc.constantFrom("major" as const, "minor" as const),
  }),
  { nil: null },
);

/** Valid single-staff specs whose measures each fill a 4/4 bar (16 sixteenths). */
const scoreArb: fc.Arbitrary<ScoreSpec> = fc
  .record({
    clef: fc.constantFrom("bass" as const, "treble" as const, "percussion" as const),
    bars: fc.array(fc.array(slotArb, { minLength: 16, maxLength: 16 }), {
      minLength: 1,
      maxLength: 4,
    }),
    key: keyArb,
  })
  .map(({ clef, bars, key }) => {
    let next = 1;
    const measures: StaffSpec["measures"] = bars.map((slots) => {
      const els: StaffSpec["measures"][number] = [];
      let remaining = 16;
      for (const s of slots) {
        if (remaining === 0) break;
        const fitting = DURATIONS.filter(([, , u]) => u <= remaining);
        const [value, dots, units] = fitting[s.pick % fitting.length] ?? [16, 0, 1];
        remaining -= units;
        if (s.rest) {
          els.push({ kind: "rest", duration: { value, dots } });
        } else {
          els.push({
            kind: "note",
            id: `n${String(next++)}`,
            pitches: s.pitches,
            duration: { value, dots, ...(s.tie === undefined ? {} : { tie: s.tie }) },
            ...(s.accidental === undefined ? {} : { accidental: s.accidental }),
          });
        }
      }
      return els;
    });
    return {
      staves: [{ clef, lines: clef === "percussion" ? 1 : 5, measures }],
      key,
      meter: { beats: 4, beatValue: 4 },
    } satisfies ScoreSpec;
  });

function sixteenths(el: { attrs: Record<string, string> }): number {
  const base = 16 / Number(el.attrs.dur);
  return el.attrs.dots === "1" ? base * 1.5 : base;
}

describe("toMei properties", () => {
  it("is well-formed, keeps ids and pitches, and fills the meter", () => {
    fc.assert(
      fc.property(scoreArb, (score) => {
        const root = parseXml(toMei(score));
        expect(root.name).toBe("mei");
        expect(root.attrs.meiversion).toBe("5.0");

        const staff = score.staves[0];
        if (staff === undefined) throw new Error("no staff");
        const measures = findAll(root, "measure");
        expect(measures).toHaveLength(staff.measures.length);

        const seen: string[] = [];
        measures.forEach((m, mi) => {
          const layer = findAll(m, "layer")[0];
          const expected = staff.measures[mi];
          if (layer === undefined || expected === undefined) throw new Error("missing measure");
          expect(layer.children.reduce((sum, el) => sum + sixteenths(el), 0)).toBe(16);
          expect(layer.children).toHaveLength(expected.length);
          expected.forEach((src, i) => {
            const out = layer.children[i];
            if (out === undefined) throw new Error("missing element");
            if (src.kind === "rest") {
              expect(out.name).toBe("rest");
              return;
            }
            seen.push(out.attrs["xml:id"] ?? "");
            expect(out.name).toBe(src.pitches.length > 1 ? "chord" : "note");
            const notes = out.name === "chord" ? out.children : [out];
            expect(notes).toHaveLength(src.pitches.length);
            notes.forEach((n, pi) => {
              expect(n.attrs.pname).toBe(src.pitches[pi]?.step.toLowerCase());
              expect(n.attrs.oct).toBe(String(src.pitches[pi]?.octave));
            });
          });
        });

        const ids = staff.measures.flat().flatMap((e) => (e.kind === "note" ? [e.id] : []));
        expect(seen).toEqual(ids);

        // Every xml:id in the document is unique, derived chord child ids included.
        const allIds = [...findAll(root, "note"), ...findAll(root, "chord")].map(
          (e) => e.attrs["xml:id"],
        );
        expect(new Set(allIds).size).toBe(allIds.length);
      }),
    );
  });
});
