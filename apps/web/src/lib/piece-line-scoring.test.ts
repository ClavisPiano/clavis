import { loadPieces } from "@clavis/content";
import {
  ExpectedResponseSchema,
  PIECES_NODE_ID,
  createPieceLine,
  createRng,
  scoreNoteIds,
  type NoteEvent,
  type SkillNode,
} from "@clavis/core";
import { scoreAttempt } from "@clavis/scoring";
import { describe, expect, it } from "vitest";

// Integration test: core cannot import content or scoring, so the web app, which depends on all
// three, checks the real piece library against the real generator and the real scorer.
const pieces = loadPieces();
const generator = createPieceLine(pieces);
const node: SkillNode = {
  id: PIECES_NODE_ID,
  strand: "APPLY",
  title: "Pieces",
  prerequisites: [],
  itemGenerators: ["pieceLine"],
  params: {},
  mastery: { minAccuracy: 0.8, windowAttempts: 5, distinctSessions: 2 },
  keyDependent: false,
};
const ctx = { rng: createRng(1), mode: "instrument" as const };
const END = 1000;

function line(expected: ReturnType<typeof generator.generate>["expected"]) {
  const play = expected.play;
  if (play?.kind !== "line") throw new Error("not a line");
  return play;
}

/** The phrase played as written, from `offsetMs` after the count-in. */
function perform(play: ReturnType<typeof line>, offsetMs = 800): NoteEvent[] {
  const beatMs = 60000 / play.tempoBpm;
  return play.midi.map((pitch, i) => ({
    pitch,
    onsetMs: END + offsetMs + (play.onsetsBeats[i] ?? 0) * beatMs,
    confidence: 1,
    source: "midi" as const,
  }));
}

describe("every phrase of the shipped library", () => {
  const items = generator.listItems(node);

  it("has one item per phrase, and each is a valid, drawable line", () => {
    const phrases = pieces.reduce((n, p) => n + p.phrases.length, 0);
    expect(items).toHaveLength(phrases);
    for (const params of items) {
      const inst = generator.generate(node, params, ctx);
      expect(ExpectedResponseSchema.safeParse(inst.expected).success).toBe(true);
      const play = line(inst.expected);
      expect(play.midi.length).toBe(scoreNoteIds(inst.display ?? { staves: [] }).length);
      expect(play.onsetsBeats[0]).toBe(0);
      expect(play.onsetsBeats).toEqual([...play.onsetsBeats].sort((a, b) => a - b));
    }
  });

  it("scores a perfect performance correct, with nothing to correct", () => {
    for (const params of items) {
      const inst = generator.generate(node, params, ctx);
      const r = scoreAttempt({
        expected: inst.expected,
        notes: perform(line(inst.expected)),
        stimulusEndMs: END,
        source: "midi",
      });
      expect(r.outcome.correct, inst.itemId).toBe(true);
      expect(r.outcome.partial, inst.itemId).toBe(1);
      expect(r.errors, inst.itemId).toEqual([]);
    }
  });

  it("still passes when the learner plays the whole phrase slower than the count-in", () => {
    for (const params of items) {
      const inst = generator.generate(node, params, ctx);
      const play = line(inst.expected);
      const slower = { ...play, tempoBpm: play.tempoBpm * 0.8 };
      const r = scoreAttempt({
        expected: inst.expected,
        notes: perform(slower),
        stimulusEndMs: END,
        source: "midi",
      });
      expect(r.outcome.correct, inst.itemId).toBe(true);
    }
  });

  it("fails a phrase with one wrong note, naming the note and not the timing", () => {
    for (const params of items) {
      const inst = generator.generate(node, params, ctx);
      const play = line(inst.expected);
      const notes = perform(play);
      const first = notes[0];
      if (!first) throw new Error("no notes");
      notes[0] = { ...first, pitch: first.pitch + 1 };
      const r = scoreAttempt({
        expected: inst.expected,
        notes,
        stimulusEndMs: END,
        source: "midi",
      });
      expect(r.outcome.correct, inst.itemId).toBe(false);
      expect(r.errors[0]?.code, inst.itemId).toBe("sequence.wrong-note");
      expect(r.errors.every((e) => e.code.startsWith("sequence."))).toBe(true);
    }
  });
});
