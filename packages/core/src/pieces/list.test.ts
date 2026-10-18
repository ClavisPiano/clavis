import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { NodeState } from "../graph/schema.js";
import { PIECE_UNLOCK_STATE, listPieces, validatePieces } from "./list.js";
import type { Piece } from "./schema.js";

function must<T>(x: T | undefined): T {
  if (x === undefined) throw new Error("expected a value");
  return x;
}

function piece(id: string, requiredNodeIds: string[], difficulty = 1): Piece {
  return {
    id: `piece.${id}`,
    title: id,
    source: "Traditional",
    score: {
      staves: [
        {
          clef: "treble",
          lines: 5,
          measures: [
            [
              {
                kind: "note",
                id: "n1",
                pitches: [{ step: "C", alter: 0, octave: 4 }],
                duration: { value: 1, dots: 0 },
              },
            ],
          ],
        },
      ],
      key: { tonic: "C", mode: "major" },
      meter: { beats: 4, beatValue: 4 },
    },
    phrases: [{ firstMeasure: 1, lastMeasure: 1 }],
    requiredNodeIds,
    difficulty,
  };
}

const learner = (states: Record<string, NodeState>) => ({
  pieces: {},
  nodes: Object.fromEntries(Object.entries(states).map(([id, state]) => [id, { state }])),
});

describe("listPieces", () => {
  const a = piece("a", ["n.x", "n.y"]);
  const b = piece("b", ["n.x"]);

  it("unlocks at fluent, the state past learning", () => {
    expect(PIECE_UNLOCK_STATE).toBe("fluent");
  });

  const table: [string, Record<string, NodeState>, boolean[], string[][]][] = [
    ["a new learner", {}, [false, false], [["n.x", "n.y"], ["n.x"]]],
    [
      "nodes only learning",
      { "n.x": "learning", "n.y": "learning" },
      [false, false],
      [["n.x", "n.y"], ["n.x"]],
    ],
    ["one node fluent", { "n.x": "fluent", "n.y": "learning" }, [false, true], [["n.y"], []]],
    ["every node fluent", { "n.x": "fluent", "n.y": "fluent" }, [true, true], [[], []]],
    ["mastered counts", { "n.x": "mastered", "n.y": "mastered" }, [true, true], [[], []]],
    [
      "available is not enough",
      { "n.x": "available", "n.y": "fluent" },
      [false, false],
      [["n.x"], ["n.x"]],
    ],
    ["an unknown node stays locked", { "n.y": "mastered" }, [false, false], [["n.x"], ["n.x"]]],
  ];

  it.each(table)("%s", (_name, states, unlocked, missing) => {
    const list = listPieces([a, b], learner(states));
    expect(list.map((s) => s.unlocked)).toEqual(unlocked);
    expect(list.map((s) => s.missingNodeIds)).toEqual(missing);
  });

  it("keeps the library's order and does not mutate its input", () => {
    const pieces = [b, a];
    const before = JSON.parse(JSON.stringify(pieces)) as Piece[];
    expect(listPieces(pieces, learner({})).map((s) => s.piece.id)).toEqual([b.id, a.id]);
    expect(pieces).toEqual(before);
  });

  it("is monotone: raising a node's state never locks a piece", () => {
    const states: NodeState[] = ["locked", "available", "learning", "fluent", "mastered"];
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 4 }), { minLength: 2, maxLength: 2 }),
        fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 2, maxLength: 2 }),
        (base, bump) => {
          const at = (xs: number[]) =>
            learner({ "n.x": must(states[must(xs[0])]), "n.y": must(states[must(xs[1])]) });
          const raised = base.map((v, i) => Math.min(4, v + (bump[i] ?? 0)));
          const before = listPieces([a, b], at(base));
          const after = listPieces([a, b], at(raised));
          for (let i = 0; i < before.length; i++) {
            const was = must(before[i]);
            const now = must(after[i]);
            if (was.unlocked) expect(now.unlocked).toBe(true);
            expect(now.missingNodeIds.length).toBeLessThanOrEqual(was.missingNodeIds.length);
          }
        },
      ),
    );
  });
});

describe("validatePieces", () => {
  const node = (id: string, generator: string) => ({ id, itemGenerators: [generator] });
  const graph = {
    nodes: [node("n.x", "g1"), node("n.off", "g2")],
    generators: [
      { id: "g1", implemented: true },
      { id: "g2", implemented: false },
    ],
  } as unknown as Parameters<typeof validatePieces>[1];

  it("accepts a consistent library", () => {
    expect(validatePieces([piece("a", ["n.x"], 1), piece("b", ["n.x"], 2)], graph)).toEqual([]);
  });

  it("reports a missing node, a disabled node, a duplicate id and an out-of-order difficulty", () => {
    const errors = validatePieces([piece("a", ["n.missing"], 3), piece("a", ["n.off"], 2)], graph);
    expect(errors).toEqual([
      "piece.a: required node n.missing is not in the graph",
      "piece.a: duplicate piece id",
      "piece.a: required node n.off has no implemented generator",
      "piece.a: difficulty 2 is below piece.a (3)",
    ]);
  });
});
