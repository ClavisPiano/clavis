import fc from "fast-check";
import { get } from "@tonaljs/note";
import { describe, expect, it } from "vitest";
import { SCORE_FIXTURES } from "./fixtures.js";
import { ScoreSpecSchema, scoreNoteIds, spelledToMidi, type Step } from "./schema.js";

const base = SCORE_FIXTURES.intervalC3G3;
const staff = base.staves[0];
const [first, second] = staff?.measures[0] ?? [];

/** A score built from the interval fixture with one part replaced, typed loosely on purpose. */
function variant(measure: unknown[], staffOver: object = {}, extraStaves = 0): unknown {
  const st = { ...staff, ...staffOver, measures: [measure] };
  return { ...base, staves: Array.from({ length: 1 + extraStaves }, () => st) };
}

describe("ScoreSpecSchema", () => {
  it.each(Object.entries(SCORE_FIXTURES))("round trips %s", (_name, fixture) => {
    const parsed = ScoreSpecSchema.parse(JSON.parse(JSON.stringify(fixture)));
    expect(parsed).toEqual(fixture);
  });

  it("accepts the unmodified variant", () => {
    expect(ScoreSpecSchema.safeParse(variant([first, second])).success).toBe(true);
  });

  const rejections: [string, unknown][] = [
    ["duration value 3", variant([{ ...first, duration: { value: 3, dots: 0 } }, second])],
    ["dots 2", variant([{ ...first, duration: { value: 4, dots: 2 } }, second])],
    ["two bass staves", variant([first, second], {}, 1)],
    ["duplicate note ids", variant([first, { ...second, id: "n1" }])],
    ["percussion with 5 lines", variant([first, second], { clef: "percussion" })],
    ["bass with 1 line", variant([first, second], { lines: 1 })],
    ["empty pitches", variant([{ ...first, pitches: [] }, second])],
    ["bad note id", variant([{ ...first, id: "x1" }, second])],
    ["extra property", variant([{ ...first, extra: 1 }, second])],
  ];
  it.each(rejections)("rejects %s", (_name, input) => {
    expect(ScoreSpecSchema.safeParse(input).success).toBe(false);
  });
});

describe("ScoreSpecSchema grand staff (R27)", () => {
  const grand = SCORE_FIXTURES.grandStaff;
  const [treble, bass] = grand.staves;
  if (treble === undefined || bass === undefined) throw new Error("fixture needs two staves");
  const parse = (staves: unknown[]) => ScoreSpecSchema.safeParse({ ...grand, staves });
  const messages = (staves: unknown[]): string[] => {
    const r = parse(staves);
    return r.success ? [] : r.error.issues.map((i) => i.message);
  };

  it("accepts treble over bass", () => {
    expect(parse([treble, bass]).success).toBe(true);
  });

  it("still accepts one staff of either clef", () => {
    expect(parse([treble]).success).toBe(true);
    expect(parse([bass]).success).toBe(true);
  });

  it("rejects no staff and three staves", () => {
    expect(parse([]).success).toBe(false);
    const third = { clef: "bass", lines: 5, measures: [[], []] };
    expect(parse([treble, bass, third]).success).toBe(false);
  });

  it("rejects bass over treble and two treble staves", () => {
    expect(messages([bass, treble])).toContain(
      "a grand staff is a treble staff above a bass staff",
    );
    const trebleOnly = { ...bass, clef: "treble" };
    expect(messages([treble, trebleOnly])).toContain(
      "a grand staff is a treble staff above a bass staff",
    );
  });

  it("rejects staves with different numbers of measures", () => {
    const short = { ...bass, measures: bass.measures.slice(0, 1) };
    expect(messages([treble, short])).toContain(
      "both staves of a grand staff need the same number of measures",
    );
  });

  it("rejects a measure that is longer on one staff", () => {
    const [m1, m2] = bass.measures;
    const longer = {
      ...bass,
      measures: [m1, [...(m2 ?? []), { kind: "rest", duration: { value: 4, dots: 0 } }]],
    };
    expect(messages([treble, longer])).toContain("measure 2 has a different length on each staff");
  });

  it("needs note ids unique across the staves", () => {
    const [m1, m2] = bass.measures;
    const clash = {
      ...bass,
      measures: [
        m1,
        (m2 ?? []).map((e) => (e.kind === "note" && e.id === "n7" ? { ...e, id: "n1" } : e)),
      ],
    };
    expect(messages([treble, clash])).toContain("note ids must be unique across the score");
  });

  it("lists ids staff by staff", () => {
    expect(scoreNoteIds(grand)).toEqual(["n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8"]);
  });
});

describe("scoreNoteIds", () => {
  it("lists ids in document order and skips rests", () => {
    expect(scoreNoteIds(SCORE_FIXTURES.percussionRhythm)).toEqual(["n1", "n2", "n3", "n4", "n5"]);
    expect(scoreNoteIds(SCORE_FIXTURES.intervalC3G3)).toEqual(["n1", "n2"]);
  });
});

describe("spelledToMidi", () => {
  it("anchors C4 = 60", () => {
    expect(spelledToMidi({ step: "C", alter: 0, octave: 4 })).toBe(60);
    expect(spelledToMidi({ step: "F", alter: 1, octave: 3 })).toBe(54);
  });

  it("agrees with tonal", () => {
    const steps: Step[] = ["C", "D", "E", "F", "G", "A", "B"];
    fc.assert(
      fc.property(
        fc.constantFrom(...steps),
        fc.integer({ min: -2, max: 2 }),
        fc.integer({ min: 0, max: 8 }),
        (step, alter, octave) => {
          const acc = alter < 0 ? "b".repeat(-alter) : "#".repeat(alter);
          const midi = get(`${step}${acc}${String(octave)}`).midi;
          expect(spelledToMidi({ step, alter, octave })).toBe(midi);
        },
      ),
    );
  });
});
