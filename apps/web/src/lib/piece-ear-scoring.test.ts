import { loadPieces } from "@clavis/content";
import {
  ExpectedResponseSchema,
  PIECE_EAR_NODE_ID,
  createPieceEar,
  createRng,
  type NoteEvent,
  type SkillNode,
} from "@clavis/core";
import { scoreAttempt } from "@clavis/scoring";
import { describe, expect, it } from "vitest";

// Integration test: the real library, the real by-ear generator and the real scorer. Only the
// played line is graded (R29): the sing cue has no response to score.
const pieces = loadPieces();
const generator = createPieceEar(pieces);
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
const ctx = { rng: createRng(1), mode: "instrument" as const };
const READY = 2000;

const item = generator.generate(node, { piece: "piece.hot-cross-buns", phrase: 1 }, ctx);
const expectedPlay = item.expected.play;
if (expectedPlay?.kind !== "line") throw new Error("not a played line");
const play = expectedPlay;
const beatMs = 60000 / play.tempoBpm;

/** The phrase played with its rhythm, starting 500 ms after Ready. */
function played(wrongAt?: number): NoteEvent[] {
  return play.midi.map((pitch, i) => ({
    pitch: i === wrongAt ? pitch + 1 : pitch,
    onsetMs: READY + 500 + (play.onsetsBeats[i] ?? 0) * beatMs,
    confidence: 1,
    source: "midi" as const,
  }));
}

const score = (notes: NoteEvent[]) =>
  scoreAttempt({ expected: item.expected, notes, stimulusEndMs: READY, source: "midi" });

describe("play it by ear: hear, cue, play (TP.6, R29)", () => {
  it("expects only a valid played line, with the sing cue on the item", () => {
    expect(ExpectedResponseSchema.safeParse(item.expected).success).toBe(true);
    expect(item.expected.sing).toBeUndefined();
    expect(item.cue).toBe(true);
  });

  it("is correct when the played line is right", () => {
    const r = score(played());
    expect(r.outcome.correct).toBe(true);
    expect(r.subScores).toEqual({ play: 1 });
    expect(r.errors).toEqual([]);
  });

  it("is incorrect for a wrong played note, and never mentions singing", () => {
    const r = score(played(1));
    expect(r.outcome.correct).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.errors)).not.toMatch(/sing|sang|sung/i);
  });

  it("times out when nothing is played", () => {
    const r = score([]);
    expect(r.outcome.correct).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain("response.timeout");
  });
});
