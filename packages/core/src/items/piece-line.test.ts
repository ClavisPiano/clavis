import { describe, expect, it } from "vitest";
import type { SkillNode } from "../graph/schema.js";
import { PieceSchema, type Piece } from "../pieces/schema.js";
import { createRng } from "../random.js";
import { ScoreSpecSchema, scoreNoteIds, type ScoreSpec } from "../score/schema.js";
import { StimulusSpecSchema } from "../stimulus/types.js";
import { ExpectedResponseSchema } from "./expected.js";
import { itemId } from "./ids.js";
import { PIECES_NODE_ID, PIECE_TEMPO_BPM, createPieceLine, lineTiming } from "./piece-line.js";
import type { GenerateContext } from "./types.js";

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

const ctx = (seed = 1): GenerateContext => ({
  rng: createRng(seed),
  mode: "instrument",
});

type El = [string, 1 | 2 | 4 | 8, (0 | 1)?, ("start" | "stop" | "continue")?];

/** A treble line in C major from bars of [pitch or "r", duration value, dots, tie]. */
function score(bars: El[][], meter: ScoreSpec["meter"] = { beats: 4, beatValue: 4 }): ScoreSpec {
  let n = 0;
  return ScoreSpecSchema.parse({
    staves: [
      {
        clef: "treble",
        lines: 5,
        measures: bars.map((bar) =>
          bar.map(([p, value, dots = 0, tie]) => {
            const duration = { value, dots, ...(tie === undefined ? {} : { tie }) };
            if (p === "r") return { kind: "rest", duration };
            n += 1;
            return {
              kind: "note",
              id: `n${String(n)}`,
              pitches: [{ step: p.slice(0, 1), alter: 0, octave: Number(p.slice(1)) }],
              duration,
            };
          }),
        ),
      },
    ],
    key: { tonic: "C", mode: "major" },
    meter,
  });
}

const SIMPLE = score([
  [
    ["C4", 4],
    ["D4", 4],
    ["E4", 2],
  ],
  [
    ["E4", 4],
    ["D4", 4],
    ["C4", 2],
  ],
]);
const RHYTHMIC = score([
  [
    ["C4", 4, 1],
    ["D4", 8],
    ["E4", 4],
    ["r", 4],
  ],
  [
    ["G4", 2, 0, "start"],
    ["G4", 2, 0, "stop"],
  ],
]);

function piece(id: string, s: ScoreSpec, phrases: [number, number][]): Piece {
  return PieceSchema.parse({
    id,
    title: id,
    source: "Traditional",
    score: s,
    phrases: phrases.map(([firstMeasure, lastMeasure]) => ({ firstMeasure, lastMeasure })),
    requiredNodeIds: ["read.treble.skips"],
    difficulty: 1,
  });
}

const PIECES = [
  piece("piece.simple", SIMPLE, [
    [1, 1],
    [2, 2],
  ]),
  piece("piece.rhythmic", RHYTHMIC, [[1, 2]]),
];
const gen = createPieceLine(PIECES);

describe("lineTiming", () => {
  it("puts onsets in beats from the first note", () => {
    expect(lineTiming(SIMPLE)).toEqual({
      midi: [60, 62, 64, 64, 62, 60],
      onsetsBeats: [0, 1, 2, 4, 5, 6],
    });
  });

  it("counts a dot, an eighth and a rest, and a tie adds no onset", () => {
    // C dotted quarter (1.5), D eighth (0.5), E quarter (1), rest quarter (1), then a tied G (2 + 2).
    expect(lineTiming(RHYTHMIC)).toEqual({
      midi: [60, 62, 64, 67],
      onsetsBeats: [0, 1.5, 2, 4],
    });
  });

  it("starts at zero when the phrase starts with a rest", () => {
    const s = score([
      [
        ["r", 4],
        ["C4", 4],
        ["D4", 2],
      ],
    ]);
    expect(lineTiming(s).onsetsBeats).toEqual([0, 1]);
  });

  it("measures beats in the meter's beat value (6/8: an eighth is one beat)", () => {
    const s = score(
      [
        [
          ["C4", 8],
          ["D4", 8],
          ["E4", 8],
          ["F4", 4, 1],
        ],
      ],
      { beats: 6, beatValue: 8 },
    );
    expect(lineTiming(s).onsetsBeats).toEqual([0, 1, 2, 3]);
  });
});

describe("pieceLine universe", () => {
  it("has one item per phrase in library order, with stable distinct ids", () => {
    const items = gen.listItems(node);
    expect(items).toEqual([
      { piece: "piece.simple", phrase: 1 },
      { piece: "piece.simple", phrase: 2 },
      { piece: "piece.rhythmic", phrase: 1 },
    ]);
    const ids = items.map((p) => itemId(node.id, p));
    expect(ids).toEqual([
      "apply.pieces|phrase=1|piece=piece.simple",
      "apply.pieces|phrase=2|piece=piece.simple",
      "apply.pieces|phrase=1|piece=piece.rhythmic",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is empty for an empty library", () => {
    expect(createPieceLine([]).listItems(node)).toEqual([]);
  });
});

describe("pieceLine generate", () => {
  const item = (params: { piece: string; phrase: number }, seed = 1) =>
    gen.generate(node, params, ctx(seed));

  it("shows the phrase and expects exactly its notes and onsets", () => {
    const i = item({ piece: "piece.simple", phrase: 2 });
    expect(i.itemId).toBe("apply.pieces|phrase=2|piece=piece.simple");
    expect(i.nodeId).toBe(PIECES_NODE_ID);
    expect(i.generator).toBe("pieceLine");
    expect(i.params).toEqual({ piece: "piece.simple", phrase: 2 });
    expect(i.display?.staves[0]?.measures).toEqual([SIMPLE.staves[0]?.measures[1]]);
    expect(i.expected.play).toEqual({
      kind: "line",
      midi: [64, 62, 60],
      onsetsBeats: [0, 1, 2],
      tempoBpm: PIECE_TEMPO_BPM,
      beatsPerBar: 4,
    });
  });

  it("a multi-measure phrase includes every measure and the rests and ties in its timing", () => {
    const i = item({ piece: "piece.rhythmic", phrase: 1 });
    expect(i.display?.staves[0]?.measures).toHaveLength(2);
    expect(i.expected.play).toMatchObject({ midi: [60, 62, 64, 67], onsetsBeats: [0, 1.5, 2, 4] });
  });

  it("the stimulus is only a count-in, one click per beat, and no phrase audio", () => {
    const i = item({ piece: "piece.simple", phrase: 1 });
    expect(StimulusSpecSchema.safeParse(i.stimulus).success).toBe(true);
    expect(i.stimulus.events).toHaveLength(4);
    expect(i.stimulus.events.every((e) => e.role === "count-in")).toBe(true);
    expect(i.stimulus.events.map((e) => e.atSec)).toEqual([0, 1, 2, 3]);
    expect(i.stimulus.tempoBpm).toBe(PIECE_TEMPO_BPM);
  });

  it("the expected response and the display validate", () => {
    for (const params of gen.listItems(node)) {
      const i = gen.generate(node, params, ctx());
      expect(ExpectedResponseSchema.safeParse(i.expected).success).toBe(true);
      expect(ScoreSpecSchema.safeParse(i.display).success).toBe(true);
    }
  });

  it("the input range covers every note with room to spare, inside the piano", () => {
    for (const params of gen.listItems(node)) {
      const i = gen.generate(node, params, ctx());
      const play = i.expected.play;
      if (play?.kind !== "line" || i.inputRange === undefined) throw new Error("no range");
      expect(i.inputRange.low).toBeLessThan(Math.min(...play.midi));
      expect(i.inputRange.high).toBeGreaterThan(Math.max(...play.midi));
      expect(i.inputRange.low).toBeGreaterThanOrEqual(21);
      expect(i.inputRange.high).toBeLessThanOrEqual(108);
    }
  });

  it("keeps the phrase's note ids and gives a response window that grows with the phrase", () => {
    const short = item({ piece: "piece.simple", phrase: 1 });
    const long = item({ piece: "piece.rhythmic", phrase: 1 });
    if (short.display === undefined) throw new Error("no display");
    expect(scoreNoteIds(short.display)).toEqual(["n1", "n2", "n3"]);
    expect(short.expected.responseWindowMs).toBeGreaterThanOrEqual(12000);
    expect(long.expected.responseWindowMs).toBeGreaterThan(short.expected.responseWindowMs);
  });

  it("is deterministic: the seed changes nothing", () => {
    const a = item({ piece: "piece.simple", phrase: 1 }, 1);
    const b = item({ piece: "piece.simple", phrase: 1 }, 999);
    expect(a).toEqual(b);
  });

  it("carries the replay params and no key (pieces are not key dependent)", () => {
    const i = item({ piece: "piece.simple", phrase: 1 });
    expect(i.presentation).toEqual({ piece: "piece.simple", phrase: 1, tempoBpm: PIECE_TEMPO_BPM });
  });

  it("passes the node's target latency through when it has one", () => {
    const i = gen.generate(
      { ...node, targetLatencyMs: 3000 },
      { piece: "piece.simple", phrase: 1 },
      ctx(),
    );
    expect(i.targetLatencyMs).toBe(3000);
    expect(item({ piece: "piece.simple", phrase: 1 }).targetLatencyMs).toBeUndefined();
  });

  it("rejects an unknown piece, a phrase out of range and malformed params", () => {
    expect(() => item({ piece: "piece.nope", phrase: 1 })).toThrow(RangeError);
    expect(() => item({ piece: "piece.simple", phrase: 3 })).toThrow(RangeError);
    expect(() => item({ piece: "piece.simple", phrase: 0 })).toThrow();
    expect(() => gen.generate(node, { piece: "piece.simple" }, ctx())).toThrow();
  });
});
