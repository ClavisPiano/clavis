import { describe, expect, it } from "vitest";
import { scoreNoteIds } from "../score/schema.js";
import { handsChords, handsFitErrors } from "./hands.js";
import { grandStaff, line } from "./line.js";
import { listPieces, validatePieces } from "./list.js";
import {
  PieceSchema,
  UserPieceSchema,
  isHandsPiece,
  phraseScore,
  pieceHand,
  type Piece,
} from "./schema.js";

/*
 * Hands-together pieces (T5.6): the grand-staff shape the library schema allows only with
 * `handsOf`, the chord-fit rule, and when such a piece unlocks.
 */

const KEY = { tonic: "C", mode: "major" } as const;
const METER = { beats: 4, beatValue: 4 } as const;
const MELODY = ["E4q D4q C4h", "D4h D4h", "E4q F4q G4h", "D4q D4q C4h"];
const I = "C3+E3+G3";
const V = "G2+B2+D3";
/** I | V | I | V I: a chord tone of the melody at every chord onset, voiced by `lhChords`. */
const CHORDS = [`${I}w`, `${V}w`, `${I}w`, `${V}h ${I}h`];
const PHRASES = [
  { firstMeasure: 1, lastMeasure: 2 },
  { firstMeasure: 3, lastMeasure: 4 },
];

function must<T>(x: T | undefined): T {
  if (x === undefined) throw new Error("expected a value");
  return x;
}

const base: Piece = PieceSchema.parse({
  id: "piece.tune",
  title: "Tune",
  source: "Traditional",
  score: line({ clef: "treble", key: KEY, meter: METER, bars: MELODY }),
  phrases: PHRASES,
  requiredNodeIds: ["read.treble.skips"],
  difficulty: 1,
});

function handsRaw(bass: readonly string[] = CHORDS, treble: readonly string[] = MELODY) {
  return {
    id: "piece.tune-hands",
    title: "Tune (hands together)",
    source: "Traditional",
    score: grandStaff({ key: KEY, meter: METER, treble, bass }),
    phrases: PHRASES,
    requiredNodeIds: ["hands.coord.basic"],
    handsOf: "piece.tune",
    difficulty: 2,
  };
}

const hands = (bass?: readonly string[]): Piece => PieceSchema.parse(handsRaw(bass));

/** The same object without its `handsOf` key. */
function withoutHandsOf(raw: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(raw).filter(([k]) => k !== "handsOf"));
}

describe("grandStaff and chord tokens", () => {
  it("numbers the treble like line() and the bass after it, and reads chords", () => {
    const score = grandStaff({ key: KEY, meter: METER, treble: MELODY, bass: CHORDS });
    expect(score.staves[0]).toEqual(base.score.staves[0]);
    const ids = scoreNoteIds(score);
    expect(ids.slice(-5)).toEqual(["n12", "n13", "n14", "n15", "n16"]);
    expect(new Set(ids).size).toBe(ids.length);
    const first = score.staves[1]?.measures[0]?.[0];
    expect(first?.kind === "note" ? first.pitches.map((p) => p.step) : []).toEqual(["C", "E", "G"]);
  });

  it.each(["C3+w", "+C3w", "C3+E#3w", "C3+E3"])("rejects the chord token %s", (token) => {
    expect(() => line({ clef: "bass", key: KEY, meter: METER, bars: [token] })).toThrow();
  });
});

describe("PieceSchema with handsOf", () => {
  it("accepts a grand staff with chords on the bass staff", () => {
    const p = hands();
    expect(isHandsPiece(p)).toBe(true);
    expect(pieceHand(p)).toBe("both");
    expect(isHandsPiece(base)).toBe(false);
  });

  it.each<[string, (raw: ReturnType<typeof handsRaw>) => unknown, string]>([
    ["two staves without handsOf", (raw) => withoutHandsOf(raw), "a piece has a single staff"],
    [
      "a single staff with handsOf",
      (raw) => ({ ...raw, score: base.score }),
      "a treble staff and a bass staff",
    ],
    [
      "staves of different lengths",
      (raw) => ({ ...handsRaw(CHORDS.slice(0, 3)), handsOf: raw.handsOf }),
      "the same number of measures",
    ],
    [
      "a chord in the melody",
      () => handsRaw(CHORDS, ["E4+G4q D4q C4h", ...MELODY.slice(1)]),
      "one pitch per note",
    ],
    [
      "a bass bar that does not fill the meter",
      () => handsRaw([`${I}h`, ...CHORDS.slice(1)]),
      "does not fill the meter",
    ],
  ])("rejects %s", (_, mutate, message) => {
    const result = PieceSchema.safeParse(mutate(handsRaw()));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(message);
  });

  it("is never an imported piece: the user schema takes neither handsOf nor a second staff", () => {
    const raw = { ...handsRaw(), id: `piece.user-${"0".repeat(26)}`, requiredNodeIds: [] };
    expect(UserPieceSchema.safeParse(raw).success).toBe(false);
    expect(UserPieceSchema.safeParse(withoutHandsOf(raw)).success).toBe(false);
  });

  it("cuts a phrase out of both staves at the same measures", () => {
    const p = hands();
    const second = phraseScore(p, 1);
    expect(second.staves.map((s) => s.measures)).toEqual([
      must(p.score.staves[0]).measures.slice(2, 4),
      must(p.score.staves[1]).measures.slice(2, 4),
    ]);
  });
});

describe("handsFitErrors", () => {
  it("reads the chords back as numerals and symbols", () => {
    expect(handsChords(hands().score).map((c) => [c.roman, c.symbol, c.onsetBeats])).toEqual([
      ["I", "C", 0],
      ["V", "G", 4],
      ["I", "C", 8],
      ["V", "G", 12],
      ["I", "C", 14],
    ]);
  });

  it("passes chords that share a pitch with the melody at every onset", () => {
    expect(handsFitErrors(hands())).toEqual([]);
    expect(handsFitErrors(base)).toEqual([]);
  });

  it("lets the tonic chord end a phrase under any note", () => {
    // Bar 2 ends phrase 1 on I under the melody's D: a cadence, so it fits.
    expect(handsFitErrors(hands([`${I}w`, `${I}w`, `${I}w`, `${V}h ${I}h`]))).toEqual([]);
  });

  it.each<[string, string[], string]>([
    [
      "IV under a D at a phrase end (only I may ignore the melody)",
      [`${I}w`, "F3+A3+C4w", `${I}w`, `${V}h ${I}h`],
      "bar 2 beat 1: IV (F) shares no note with the melody's D",
    ],
    [
      "V under an E mid-phrase",
      [`${V}w`, `${V}w`, `${I}w`, `${V}h ${I}h`],
      "bar 1 beat 1: V (G) shares no note with the melody's E",
    ],
    [
      "a chord an octave from the nearest root",
      ["C2+E2+G2w", ...CHORDS.slice(1)],
      "bar 1: I is not voiced with the root nearest the one before",
    ],
    [
      "a chord off the first or middle beat",
      [`${I}q ${I}h.`, ...CHORDS.slice(1)],
      "bar 1 beat 2: a chord starts on the first beat or the middle of the bar",
    ],
    [
      "a chord a quarter long",
      [`${I}q ${I}h.`, ...CHORDS.slice(1)],
      "bar 1 beat 1: a chord lasts a whole or a half bar",
    ],
    ["two notes, not a triad", ["C3+E3w", ...CHORDS.slice(1)], "not a root-position I, IV or V"],
    ["an inversion", ["E3+G3+C4w", ...CHORDS.slice(1)], "not a root-position I, IV or V"],
    ["a rest", ["rw", ...CHORDS.slice(1)], "bar 1: the left hand rests"],
    ["ending on V", [...CHORDS.slice(0, 3), `${I}h ${V}h`], "the last chord is V, not I"],
  ])("flags %s", (_, bass, message) => {
    const errors = handsFitErrors(hands(bass));
    expect(
      errors.some((e) => e.includes(message)),
      errors.join("\n"),
    ).toBe(true);
  });
});

describe("listPieces and validatePieces with a hands-together piece", () => {
  const node = (state: "available" | "learning" | "fluent" | "mastered") => ({ state });
  type Learner = Parameters<typeof listPieces>[1];

  it.each<[string, Learner, boolean, string[], string[]]>([
    [
      "the tune not played through",
      { nodes: { "hands.coord.basic": node("fluent") }, pieces: {} },
      false,
      [],
      ["piece.tune"],
    ],
    [
      "the tune run but with a mistake (no completedAt)",
      {
        nodes: { "hands.coord.basic": node("mastered") },
        pieces: { "piece.tune": { phrases: {}, runs: 1, lastRunAt: 5 } },
      },
      false,
      [],
      ["piece.tune"],
    ],
    [
      "hands.coord.basic still learning",
      {
        nodes: { "hands.coord.basic": node("learning") },
        pieces: { "piece.tune": { phrases: {}, runs: 1, completedAt: 5 } },
      },
      false,
      ["hands.coord.basic"],
      [],
    ],
    [
      "both met",
      {
        nodes: { "hands.coord.basic": node("fluent") },
        pieces: { "piece.tune": { phrases: {}, runs: 1, completedAt: 5 } },
      },
      true,
      [],
      [],
    ],
  ])("%s", (_, learner, unlocked, missingNodeIds, missingPieceIds) => {
    const status = must(listPieces([hands()], learner)[0]);
    expect(status).toMatchObject({ unlocked, missingNodeIds, missingPieceIds });
  });

  it("checks the hands piece against its one-hand piece and the fit rule", () => {
    const graph = {
      nodes: [
        { id: "read.treble.skips", itemGenerators: ["trebleNoteRead"] },
        { id: "hands.coord.basic", itemGenerators: ["coordTask"] },
      ],
      generators: [
        { id: "trebleNoteRead", implemented: true },
        { id: "coordTask", implemented: true },
      ],
    } as unknown as Parameters<typeof validatePieces>[1];
    expect(validatePieces([base, hands()], graph)).toEqual([]);
    expect(validatePieces([hands(), base], graph)).toContain(
      "piece.tune-hands: handsOf piece.tune is not an earlier one-hand piece",
    );
    const otherTune = PieceSchema.parse(
      handsRaw(CHORDS, ["E4q D4q C4h", "D4h D4h", "E4q F4q G4h", "D4q E4q C4h"]),
    );
    expect(validatePieces([base, otherTune], graph)).toContain(
      "piece.tune-hands: the treble staff is not the melody of piece.tune",
    );
    const misfit = hands([`${V}w`, ...CHORDS.slice(1)]);
    expect(validatePieces([base, misfit], graph).join("\n")).toContain("shares no note");
  });
});
