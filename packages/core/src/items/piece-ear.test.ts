import { describe, expect, it } from "vitest";
import type { SkillNode } from "../graph/schema.js";
import { line } from "../pieces/line.js";
import { PieceSchema, type Piece } from "../pieces/schema.js";
import { createRng } from "../random.js";
import { StimulusSpecSchema } from "../stimulus/types.js";
import { ExpectedResponseSchema } from "./expected.js";
import { itemId } from "./ids.js";
import { PIECE_EAR_NODE_ID, createPieceEar } from "./piece-ear.js";
import { createPieceLine, lineNotes, PIECES_NODE_ID } from "./piece-line.js";
import type { GenerateContext } from "./types.js";

const node: SkillNode = {
  id: PIECE_EAR_NODE_ID,
  strand: "APPLY",
  title: "Pieces by ear",
  prerequisites: [],
  itemGenerators: ["pieceEar"],
  params: {},
  mastery: { minAccuracy: 0.8, windowAttempts: 5, distinctSessions: 2 },
  keyDependent: false,
};
const ctx: GenerateContext = {
  rng: createRng(1),
  mode: "instrument",
};

const PIECE: Piece = PieceSchema.parse({
  id: "piece.demo",
  title: "Demo",
  source: "Traditional",
  score: line({
    clef: "treble",
    key: { tonic: "C", mode: "major" },
    meter: { beats: 4, beatValue: 4 },
    bars: ["C4q. D4e E4h", "E4q D4q C4h"],
  }),
  phrases: [
    { firstMeasure: 1, lastMeasure: 1 },
    { firstMeasure: 2, lastMeasure: 2 },
  ],
  requiredNodeIds: ["read.treble.skips"],
  difficulty: 1,
});
const gen = createPieceEar([PIECE]);
const item = (phrase: number) => gen.generate(node, { piece: PIECE.id, phrase }, ctx);

describe("pieceEar", () => {
  it("lists one item per phrase, in order", () => {
    expect(gen.listItems(node)).toEqual([
      { piece: "piece.demo", phrase: 1 },
      { piece: "piece.demo", phrase: 2 },
    ]);
  });

  it("is a different item from the reading phrase, so the two never share a card", () => {
    const reading = createPieceLine([PIECE]).generate(
      { ...node, id: PIECES_NODE_ID, itemGenerators: ["pieceLine"] },
      { piece: PIECE.id, phrase: 1 },
      ctx,
    );
    expect(item(1).itemId).toBe(itemId(PIECE_EAR_NODE_ID, { piece: PIECE.id, phrase: 1 }));
    expect(item(1).itemId).not.toBe(reading.itemId);
  });

  it("has no notation to show while answering, and reveals the phrase's score afterwards", () => {
    const i = item(2);
    expect(i.display).toBeUndefined();
    expect(i.staff).toBeUndefined();
    expect(i.reveal?.staves[0]?.measures).toHaveLength(1);
    expect(lineNotes(i.reveal ?? PIECE.score).map((n) => n.midi)).toEqual([64, 62, 60]);
  });

  it("expects only the notes played as a line, with an ungraded sing cue (R29)", () => {
    const i = item(1);
    expect(ExpectedResponseSchema.safeParse(i.expected).success).toBe(true);
    expect(i.expected.sing).toBeUndefined();
    expect(i.cue).toBe(true);
    expect(i.expected.play).toEqual({
      kind: "line",
      midi: [60, 62, 64],
      onsetsBeats: [0, 1.5, 2],
      tempoBpm: 60,
      beatsPerBar: 4,
    });
  });

  it("plays a bar of clicks and then the phrase with its real rhythm and note lengths", () => {
    const { stimulus } = item(1);
    expect(StimulusSpecSchema.safeParse(stimulus).success).toBe(true);
    const clicks = stimulus.events.filter((e) => e.role === "count-in");
    const tune = stimulus.events.filter((e) => e.role === "target");
    expect(clicks.map((e) => e.atSec)).toEqual([0, 1, 2, 3]);
    expect(tune.map((e) => e.midi)).toEqual([[60], [62], [64]]);
    expect(tune.map((e) => e.atSec)).toEqual([4, 5.5, 6]);
    // A dotted quarter rings for 1.5 beats (less a gap), the eighth for half a beat.
    expect(tune.map((e) => e.durationSec)).toEqual([
      expect.closeTo(1.35, 5),
      expect.closeTo(0.45, 5),
      expect.closeTo(1.8, 5),
    ]);
  });

  it("is deterministic: the same item twice is identical", () => {
    expect(item(1)).toEqual(item(1));
  });

  it("throws for an unknown piece or a phrase past the end", () => {
    expect(() => gen.generate(node, { piece: "piece.nope", phrase: 1 }, ctx)).toThrow(RangeError);
    expect(() => gen.generate(node, { piece: PIECE.id, phrase: 3 }, ctx)).toThrow(RangeError);
  });
});
