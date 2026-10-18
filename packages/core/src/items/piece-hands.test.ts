import { describe, expect, it } from "vitest";
import type { SkillNode } from "../graph/schema.js";
import {
  ALPHA,
  ALPHA_HANDS,
  ALPHA_HANDS_PIECE,
  HANDS_FIXTURE_PIECES,
} from "../composer/fixtures/pieces.js";
import { createRng } from "../random.js";
import { PerformanceTargetSchema } from "./expected.js";
import { createPieceEar } from "./piece-ear.js";
import { PIECE_HANDS_NODE_ID, createPieceHands, performanceNotes } from "./piece-hands.js";
import { createPieceLine } from "./piece-line.js";
import type { GenerateContext } from "./types.js";

const NODE: SkillNode = {
  id: PIECE_HANDS_NODE_ID,
  strand: "APPLY",
  title: "Pieces, hands together",
  prerequisites: [],
  itemGenerators: ["pieceHands"],
  params: {},
  mastery: { minAccuracy: 0.8, windowAttempts: 5, distinctSessions: 2 },
  keyDependent: false,
};
const CTX = { rng: createRng(1) } as unknown as GenerateContext;
const gen = createPieceHands(HANDS_FIXTURE_PIECES);

describe("pieceHands (T5.6)", () => {
  it("lists the phrases of hands-together pieces only, and the one-hand generators skip them", () => {
    expect(gen.listItems(NODE)).toEqual([
      { piece: ALPHA_HANDS, phrase: 1 },
      { piece: ALPHA_HANDS, phrase: 2 },
    ]);
    const pieces = (g: typeof gen) => new Set(g.listItems(NODE).map((p) => p.piece));
    expect(pieces(createPieceLine(HANDS_FIXTURE_PIECES)).has(ALPHA_HANDS)).toBe(false);
    expect(pieces(createPieceEar(HANDS_FIXTURE_PIECES)).has(ALPHA_HANDS)).toBe(false);
    expect(pieces(createPieceLine(HANDS_FIXTURE_PIECES)).has(ALPHA)).toBe(true);
    expect(() => gen.generate(NODE, { piece: ALPHA, phrase: 1 }, CTX)).toThrow(RangeError);
    expect(() => gen.generate(NODE, { piece: ALPHA_HANDS, phrase: 3 }, CTX)).toThrow(RangeError);
  });

  it("shows the phrase on a grand staff and expects both hands as a performance", () => {
    const item = gen.generate(NODE, { piece: ALPHA_HANDS, phrase: 2 }, CTX);
    expect(item.itemId).toBe(`${PIECE_HANDS_NODE_ID}|phrase=2|piece=${ALPHA_HANDS}`);
    expect(item.generator).toBe("pieceHands");
    expect(item.display?.staves.map((s) => [s.clef, s.measures.length])).toEqual([
      ["treble", 2],
      ["bass", 2],
    ]);
    const play = item.expected.play;
    expect(PerformanceTargetSchema.safeParse(play).success).toBe(true);
    if (play?.kind !== "performance") throw new Error("expected a performance");
    expect(play.tempoBpm).toBe(60);
    expect(play.beatsPerBar).toBe(4);
    // Bars 3 and 4: C4 E4 G4 | G4 E4 C4 over two whole-note C chords, beat 0 the phrase's downbeat.
    expect(play.notes.map((n) => [n.id, n.midi, n.onsetBeats, n.durationBeats, n.hand])).toEqual([
      ["n7", 60, 0, 1, "rh"],
      ["n15.0", 48, 0, 4, "lh"],
      ["n15.1", 52, 0, 4, "lh"],
      ["n15.2", 55, 0, 4, "lh"],
      ["n8", 64, 1, 1, "rh"],
      ["n9", 67, 2, 2, "rh"],
      ["n10", 67, 4, 1, "rh"],
      ["n16.0", 48, 4, 4, "lh"],
      ["n16.1", 52, 4, 4, "lh"],
      ["n16.2", 55, 4, 4, "lh"],
      ["n11", 64, 5, 1, "rh"],
      ["n12", 60, 6, 2, "rh"],
    ]);
    // A count-in only: nothing of the phrase sounds before the learner plays (R17).
    expect(item.stimulus.events.map((e) => e.role)).toEqual(Array(4).fill("count-in"));
    expect(item.presentation).toMatchObject({
      piece: ALPHA_HANDS,
      phrase: 2,
      prog: ["I", "I"],
      symbols: ["C", "C"],
    });
    expect(item.inputRange).toEqual({ low: 41, high: 74 });
  });

  it("names chord tones n15.0 and single notes n7, as expectedFromScore does", () => {
    const notes = performanceNotes(ALPHA_HANDS_PIECE.score);
    expect(new Set(notes.map((n) => n.id)).size).toBe(notes.length);
    expect(notes.filter((n) => n.hand === "lh")).toHaveLength(12);
    expect(notes.filter((n) => n.hand === "rh").map((n) => n.id)).toEqual(
      Array.from({ length: 12 }, (_, i) => `n${String(i + 1)}`),
    );
    const onsets = notes.map((n) => n.onsetBeats);
    expect(onsets).toEqual([...onsets].sort((a, b) => a - b));
  });
});
