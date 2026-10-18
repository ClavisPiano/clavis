import { loadGraph, loadPieces } from "@clavis/content";
import { createPieceHands, createRng, type PerformanceTarget } from "@clavis/core";
import { expectedFromScore, scoreAttempt } from "@clavis/scoring";
import { describe, expect, it } from "vitest";
import { noteAt } from "./session/test-harness";

/* Hands-together pieces (T5.6): every phrase of the five library pieces is graded as a two-hand
   performance from the grand staff it shows. Real content, generator and scorer. */

const graph = loadGraph();
const node = graph.nodes.find((n) => n.id === "apply.pieces-hands");
if (node === undefined) throw new Error("no apply.pieces-hands in the graph");
const gen = createPieceHands(loadPieces());
const generate = (params: { piece: string; phrase: number }) =>
  gen.generate(node, params, { rng: createRng(1), mode: "instrument" });

function play(target: PerformanceTarget, change?: (id: string, midi: number) => number) {
  const start = 10_000;
  const beatMs = 60_000 / target.tempoBpm;
  return target.notes.map((n, k) =>
    // Both hands together within a few milliseconds, as a real keyboard reports them.
    noteAt(change?.(n.id, n.midi) ?? n.midi, start + n.onsetBeats * beatMs + (k % 3) * 4, "midi"),
  );
}

describe("scoring a hands-together phrase", () => {
  it("expects exactly what the grand staff shows, and passes a perfect MIDI performance", () => {
    for (const params of gen.listItems(node)) {
      const inst = generate(params as { piece: string; phrase: number });
      const target = inst.expected.play;
      if (target?.kind !== "performance" || inst.display === undefined) {
        throw new Error("expected a performance with a display");
      }
      expect(expectedFromScore(inst.display), inst.itemId).toEqual(target.notes);
      const result = scoreAttempt({
        expected: inst.expected,
        notes: play(target),
        stimulusEndMs: 10_000 - 600,
        source: "midi",
      });
      expect(result.outcome.correct, inst.itemId).toBe(true);
      expect(result.errors).toEqual([]);
    }
  });

  it("fails a wrong left-hand chord tone and names its bar and hand", () => {
    const inst = generate({ piece: "piece.ode-to-joy-hands", phrase: 1 });
    const target = inst.expected.play as PerformanceTarget;
    // Bar 2 of the phrase is V (G2 B2 D3): play its root a semitone low.
    const root = target.notes.find((n) => n.hand === "lh" && n.onsetBeats === 4);
    if (root === undefined) throw new Error("no chord in bar 2");
    expect(root.midi).toBe(43);
    const result = scoreAttempt({
      expected: inst.expected,
      notes: play(target, (id, midi) => (id === root.id ? midi - 1 : midi)),
      stimulusEndMs: 10_000 - 600,
      source: "midi",
    });
    expect(result.outcome.correct).toBe(false);
    expect(result.errors[0]).toMatchObject({
      code: "note.wrong",
      detail: { id: root.id, measure: 2, beat: 1, hand: "lh" },
    });
  });
});
