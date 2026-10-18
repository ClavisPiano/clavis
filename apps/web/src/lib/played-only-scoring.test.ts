import { loadGraph, loadPieces } from "@clavis/content";
import {
  PIECE_EAR_NODE_ID,
  createPieceEar,
  createRng,
  getGenerator,
  type GeneratorId,
  type ItemInstance,
  type NoteEvent,
  type SkillNode,
} from "@clavis/core";
import { scoreAttempt } from "@clavis/scoring";
import { describe, expect, it } from "vitest";

/*
 * R29: degree, cell, play-by-ear and by-ear items are graded on the played part only. A correct
 * played answer is correct, a wrong one is not, and no error mentions singing.
 */

const graph = loadGraph();
const READY = 1000;
const ctx = (mode: "instrument" | "away") => ({ rng: createRng(5), mode });

function nodeFor(generator: GeneratorId): SkillNode {
  const node = graph.nodes.find((n) => n.itemGenerators.includes(generator));
  if (node === undefined) throw new Error(`no node for ${generator}`);
  return node;
}

function earPhraseNode(): SkillNode {
  return {
    id: PIECE_EAR_NODE_ID,
    strand: "APPLY",
    title: "Pieces by ear",
    prerequisites: [],
    itemGenerators: ["pieceEar"],
    params: {},
    mastery: { minAccuracy: 0.8, windowAttempts: 5, distinctSessions: 2 },
    keyDependent: false,
  };
}

/** The notes of a correct answer, spaced 500 ms apart after Ready. */
function correctNotes(inst: ItemInstance): NoteEvent[] {
  const play = inst.expected.play;
  const note = (pitch: number, i: number): NoteEvent => ({
    pitch,
    onsetMs: READY + 500 + i * 500,
    confidence: 1,
    source: "midi",
  });
  switch (play?.kind) {
    case "pitchClass":
    case "exactPitch":
      return [note(play.targetMidi, 0)];
    case "sequence":
      return play.midi.map(note);
    case "line": {
      const beatMs = 60000 / play.tempoBpm;
      return play.midi.map((pitch, i) => ({
        pitch,
        onsetMs: READY + 500 + (play.onsetsBeats[i] ?? 0) * beatMs,
        confidence: 1,
        source: "midi" as const,
      }));
    }
    default:
      throw new Error("unexpected target kind");
  }
}

function wrongNotes(inst: ItemInstance): NoteEvent[] {
  const notes = correctNotes(inst);
  const [first, ...rest] = notes;
  if (first === undefined) throw new Error("no notes");
  // A semitone off is never the same pitch class, and for a line never the same note.
  return [{ ...first, pitch: first.pitch + 1 }, ...rest];
}

const cases: { name: string; make: (mode: "instrument" | "away") => ItemInstance }[] = [
  ...(["degreeSing", "degreeId", "cellEcho", "byEarPhrase"] as const).map((id) => ({
    name: id,
    make: (mode: "instrument" | "away") => {
      const gen = getGenerator(id);
      const node = nodeFor(id);
      const params = gen.listItems(node)[0];
      if (params === undefined) throw new Error(`no items for ${id}`);
      return gen.generate(node, params, ctx(mode));
    },
  })),
  {
    name: "pieceEar",
    make: (mode) => {
      const gen = createPieceEar(loadPieces());
      const params = gen.listItems(earPhraseNode())[0];
      if (params === undefined) throw new Error("no phrases");
      return gen.generate(earPhraseNode(), params, ctx(mode));
    },
  },
];

describe.each(cases)("$name is graded on the played part only (R29)", ({ make }) => {
  it.each(["instrument", "away"] as const)("in %s mode", (mode) => {
    const inst = make(mode);
    expect(inst.expected.sing).toBeUndefined();
    const score = (notes: NoteEvent[]) =>
      scoreAttempt({
        expected: inst.expected,
        notes,
        stimulusEndMs: READY,
        source: mode === "away" ? "tap" : "midi",
      });

    const right = score(correctNotes(inst));
    expect(right.outcome.correct).toBe(true);
    expect(right.subScores).toEqual({ play: 1 });

    const wrong = score(wrongNotes(inst));
    expect(wrong.outcome.correct).toBe(false);
    expect(wrong.errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(wrong.errors)).not.toMatch(/sing|sang|sung/i);
  });
});
