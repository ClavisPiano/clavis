import { describe, expect, it } from "vitest";
import { PieceSchema, measureUnits, phraseScore, pieceHand, type Piece } from "./schema.js";
import { ScoreSpecSchema, scoreNoteIds, type ScoreNote, type ScoreSpec } from "../score/schema.js";

let nextId = 0;

function must<T>(x: T | undefined): T {
  if (x === undefined) throw new Error("expected a value");
  return x;
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}
function note(step: "C" | "D" | "E", value: 1 | 2 | 4 | 8, dots: 0 | 1 = 0): ScoreNote {
  nextId += 1;
  return {
    kind: "note",
    id: `n${String(nextId)}`,
    pitches: [{ step, alter: 0, octave: 4 }],
    duration: { value, dots },
  };
}

function score(measures: ScoreNote[][], clef: "treble" | "bass" = "treble"): ScoreSpec {
  return ScoreSpecSchema.parse({
    staves: [{ clef, lines: 5, measures }],
    key: { tonic: "C", mode: "major" },
    meter: { beats: 4, beatValue: 4 },
  });
}

/** Two full 4/4 measures, split into two one-measure phrases. */
function good(): Piece {
  nextId = 0;
  return {
    id: "piece.test",
    title: "Test",
    source: "Traditional",
    score: score([
      [note("C", 4), note("D", 4), note("E", 2)],
      [note("E", 4, 1), note("D", 8), note("C", 2)],
    ]),
    phrases: [
      { firstMeasure: 1, lastMeasure: 1 },
      { firstMeasure: 2, lastMeasure: 2 },
    ],
    requiredNodeIds: ["read.treble.landmarks"],
    difficulty: 1,
  };
}

describe("PieceSchema", () => {
  it("accepts a well-formed piece", () => {
    expect(PieceSchema.safeParse(good()).success).toBe(true);
  });

  it("measures are counted in 64ths of a whole note", () => {
    expect(measureUnits(good().score)).toBe(64);
    expect(measureUnits({ ...good().score, meter: { beats: 6, beatValue: 8 } })).toBe(48);
    expect(measureUnits({ ...good().score, meter: null })).toBeNull();
  });

  const bad: [string, (p: Piece) => void, string][] = [
    ["a bad id", (p) => void (p.id = "test"), "id"],
    ["an empty title", (p) => void (p.title = ""), "title"],
    [
      "a first phrase that skips measure 1",
      (p) => void (must(p.phrases[0]).firstMeasure = 2),
      "tile",
    ],
    [
      "a gap between phrases",
      (p) => void (p.phrases = [{ firstMeasure: 1, lastMeasure: 1 }]),
      "phrases end at measure 1",
    ],
    [
      "overlapping phrases",
      (p) =>
        void (p.phrases = [
          { firstMeasure: 1, lastMeasure: 2 },
          { firstMeasure: 2, lastMeasure: 2 },
        ]),
      "tile",
    ],
    [
      "phrases that run past the score",
      (p) => void (must(p.phrases[1]).lastMeasure = 3),
      "phrases end at measure 3",
    ],
    [
      "a phrase that ends before it starts",
      (p) => void (p.phrases[1] = { firstMeasure: 2, lastMeasure: 1 }),
      "end before it starts",
    ],
    ["no key", (p) => void (p.score = { ...p.score, key: null }), "key"],
    ["no meter", (p) => void (p.score = { ...p.score, meter: null }), "meter"],
    [
      "a short measure",
      (p) => void must(must(p.score.staves[0]).measures[0]).pop(),
      "does not fill the meter",
    ],
    ["an empty measure", (p) => void (must(p.score.staves[0]).measures[1] = []), "is empty"],
    [
      "a chord",
      (p) => {
        const first = must(must(must(p.score.staves[0]).measures[0])[0]) as ScoreNote;
        first.pitches.push({ step: "E", alter: 0, octave: 4 });
      },
      "single line",
    ],
    [
      "a grand staff",
      (p) => {
        const treble = must(p.score.staves[0]);
        p.score.staves.push({
          clef: "bass",
          lines: 5,
          measures: treble.measures.map(() => [{ kind: "rest", duration: { value: 1, dots: 0 } }]),
        });
      },
      "a piece has a single staff",
    ],
    ["no required nodes", (p) => void (p.requiredNodeIds = []), "requiredNodeIds"],
    [
      "duplicate required nodes",
      (p) => void (p.requiredNodeIds = ["read.treble.landmarks", "read.treble.landmarks"]),
      "unique",
    ],
    ["difficulty 0", (p) => void (p.difficulty = 0), "difficulty"],
    ["difficulty 11", (p) => void (p.difficulty = 11), "difficulty"],
  ];

  it.each(bad)("rejects %s", (_name, mutate, fragment) => {
    const p = clone(good());
    mutate(p);
    const result = PieceSchema.safeParse(p);
    expect(result.success).toBe(false);
    if (!result.success) {
      const text = result.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("\n");
      expect(text).toContain(fragment);
    }
  });

  it("rejects an unknown field", () => {
    expect(PieceSchema.safeParse({ ...good(), tempo: 90 }).success).toBe(false);
  });

  it("rejects a percussion staff", () => {
    const p = good();
    p.score = ScoreSpecSchema.parse({
      staves: [{ clef: "percussion", lines: 1, measures: must(p.score.staves[0]).measures }],
      key: null,
      meter: { beats: 4, beatValue: 4 },
    });
    expect(PieceSchema.safeParse(p).success).toBe(false);
  });
});

describe("pieceHand and phraseScore", () => {
  it("the treble staff is the right hand and the bass staff the left", () => {
    const p = good();
    expect(pieceHand(p)).toBe("right");
    expect(pieceHand({ score: score([[note("C", 1)]], "bass") })).toBe("left");
  });

  it("a phrase score holds exactly the phrase's measures and keeps note ids", () => {
    const p = good();
    const second = phraseScore(p, 1);
    expect(second.staves[0]?.measures).toEqual([must(p.score.staves[0]).measures[1]]);
    expect(scoreNoteIds(second)).toEqual(["n4", "n5", "n6"]);
    expect(second.key).toEqual(p.score.key);
    expect(ScoreSpecSchema.safeParse(second).success).toBe(true);
  });

  it("phrase scores together hold every note once", () => {
    const p = good();
    const ids = p.phrases.flatMap((_, i) => scoreNoteIds(phraseScore(p, i)));
    expect(ids).toEqual(scoreNoteIds(p.score));
  });

  it("throws on a phrase that does not exist", () => {
    expect(() => phraseScore(good(), 2)).toThrow(RangeError);
  });
});
