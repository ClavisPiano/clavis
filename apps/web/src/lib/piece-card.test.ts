import { describe, expect, it } from "vitest";
import { loadGraph, loadPieces } from "@clavis/content";
import {
  pieceHand as pieceHandOf,
  type LearnerState,
  type NodeState,
  type SkillGraph,
} from "@clavis/core";
import { pieceCard, piecesEnabled } from "./piece-card";

const shipped = loadGraph();
const graph: SkillGraph = shipped;
const pieces = loadPieces();
const HCB = "piece.hot-cross-buns";
const ODE = "piece.ode-to-joy";

function learner(
  treble: NodeState,
  o: {
    phrases?: Record<string, Record<string, number>>;
    completed?: string[];
    runs?: Record<string, number>;
    bass?: NodeState;
    coord?: NodeState;
  } = {},
): LearnerState {
  const nodes: LearnerState["nodes"] = { "hands.coord.basic": { state: o.coord ?? "locked" } };
  for (const id of ["landmarks", "steps", "skips"]) {
    nodes[`read.treble.${id}`] = { state: treble };
    nodes[`read.bass.${id}`] = { state: o.bass ?? "locked" };
  }
  const state = { nodes, pieces: {}, cards: {}, attempts: {} } as unknown as LearnerState;
  for (const [id, byPhrase] of Object.entries(o.phrases ?? {})) {
    state.pieces[id] = {
      phrases: Object.fromEntries(
        Object.entries(byPhrase).map(([n, correct]) => [
          n,
          { attempts: correct + 1, correct, lastAt: 1, lastCorrect: correct > 0 },
        ]),
      ),
      runs: o.runs?.[id] ?? 0,
    };
  }
  for (const id of o.completed ?? []) {
    state.pieces[id] = { ...(state.pieces[id] ?? { phrases: {}, runs: 1 }), completedAt: 5 };
  }
  return state;
}

const row = (data: ReturnType<typeof pieceCard>, id: string) => data?.rows.find((r) => r.id === id);

describe("piecesEnabled", () => {
  it("is on in the shipped graph, off when pieceLine is not implemented", () => {
    expect(piecesEnabled(shipped)).toBe(true);
    const off: SkillGraph = {
      ...shipped,
      generators: shipped.generators.map((g) =>
        g.id === "pieceLine" ? { ...g, implemented: false } : g,
      ),
    };
    expect(piecesEnabled(off)).toBe(false);
    expect(pieceCard(pieces, learner("fluent"), off)).toBeUndefined();
  });

  it("has nothing to show for an empty library", () => {
    expect(pieceCard([], learner("fluent"), graph)).toBeUndefined();
  });
});

describe("pieceCard", () => {
  it("lists the whole library in order, every piece locked for a new learner", () => {
    const data = pieceCard(pieces, learner("available"), graph);
    expect(data?.rows.map((r) => r.id)).toEqual(pieces.map((p) => p.id));
    expect(data?.rows.every((r) => r.status === "locked")).toBe(true);
    expect(data?.current).toBeUndefined();
    expect(data?.completed).toEqual([]);
  });

  it("says what unlocks a locked piece, by skill title", () => {
    const data = pieceCard(pieces, learner("learning"), graph);
    expect(row(data, HCB)?.missing).toEqual(["Treble landmarks", "Treble steps", "Treble skips"]);
    const bass = row(data, "piece.mary-had-a-little-lamb-lh");
    expect(bass?.missing).toEqual(["Bass landmarks", "Bass steps", "Bass skips"]);
    const half = pieceCard(
      pieces,
      {
        ...learner("fluent"),
        nodes: { ...learner("fluent").nodes, "read.treble.skips": { state: "learning" } },
      },
      graph,
    );
    expect(row(half, HCB)?.missing).toEqual(["Treble skips"]);
  });

  const table: [string, LearnerState, Record<string, string>][] = [
    [
      "treble fluent, nothing played: the first piece is current, the rest of the right hand next",
      learner("fluent"),
      { [HCB]: "playing", [ODE]: "next", "piece.mary-had-a-little-lamb-lh": "locked" },
    ],
    [
      "every phrase played right: ready to play through",
      learner("fluent", { phrases: { [HCB]: { "1": 1, "2": 2 } } }),
      { [HCB]: "ready", [ODE]: "next" },
    ],
    [
      "a phrase only played wrong does not count as learned",
      learner("fluent", { phrases: { [HCB]: { "1": 1, "2": 0 } } }),
      { [HCB]: "playing" },
    ],
    [
      "played through: done, and the next piece becomes current",
      learner("fluent", { completed: [HCB] }),
      { [HCB]: "completed", [ODE]: "playing" },
    ],
    ["mastered counts as unlocked too", learner("mastered"), { [HCB]: "playing" }],
    [
      "bass pieces unlock with the bass nodes",
      learner("fluent", {
        bass: "fluent",
        completed: pieces.filter((p) => !p.id.endsWith("-lh")).map((p) => p.id),
      }),
      { "piece.mary-had-a-little-lamb-lh": "playing", "piece.ode-to-joy-lh": "next" },
    ],
  ];

  it.each(table)("%s", (_name, state, expected) => {
    const data = pieceCard(pieces, state, graph);
    for (const [id, status] of Object.entries(expected)) {
      expect(row(data, id)?.status, id).toBe(status);
    }
  });

  it("counts learned phrases, runs and the hand of each piece", () => {
    const data = pieceCard(
      pieces,
      learner("fluent", { phrases: { [HCB]: { "1": 3 } }, runs: { [HCB]: 2 } }),
      graph,
    );
    expect(row(data, HCB)).toMatchObject({
      phraseCount: 2,
      learned: 1,
      runs: 2,
      hand: "right",
      title: "Hot Cross Buns",
    });
    expect(row(data, "piece.twinkle-twinkle-lh")?.hand).toBe("left");
  });

  it("only one piece is current at a time, and it is the first unlocked one not played through", () => {
    const data = pieceCard(pieces, learner("fluent", { completed: [HCB, ODE] }), graph);
    expect(data?.rows.filter((r) => r.status === "playing" || r.status === "ready")).toHaveLength(
      1,
    );
    expect(data?.current?.id).toBe("piece.mary-had-a-little-lamb");
    expect(data?.completed.map((r) => r.id)).toEqual([HCB, ODE]);
  });

  it("is pure: the state is not changed", () => {
    const state = learner("fluent", { phrases: { [HCB]: { "1": 1 } } });
    const before = JSON.stringify(state);
    pieceCard(pieces, state, graph);
    expect(JSON.stringify(state)).toBe(before);
  });

  it("a hands-together piece (T5.6) waits for its tune and hands.coord.basic", () => {
    const HANDS = "piece.ode-to-joy-hands";
    const locked = pieceCard(pieces, learner("fluent", { coord: "learning" }), graph);
    expect(row(locked, HANDS)).toMatchObject({
      status: "locked",
      hand: "both",
      missing: ["Hands together, block chords"],
      after: "Ode to Joy",
    });
    const tuneOnly = pieceCard(pieces, learner("fluent", { coord: "fluent" }), graph);
    expect(row(tuneOnly, HANDS)).toMatchObject({ status: "locked", missing: [] });
  });

  it("teaches the current hands piece alongside the current one-hand piece", () => {
    const HANDS = "piece.hot-cross-buns-hands";
    const data = pieceCard(pieces, learner("fluent", { coord: "fluent", completed: [HCB] }), graph);
    expect(data?.current?.id).toBe(ODE);
    expect(data?.handsCurrent?.id).toBe(HANDS);
    expect(row(data, HANDS)?.status).toBe("playing");
    // Only the first unlocked hands piece is current; the next one waits.
    const two = pieceCard(
      pieces,
      learner("fluent", { coord: "fluent", completed: [HCB, ODE] }),
      graph,
    );
    expect(row(two, HANDS)?.status).toBe("playing");
    expect(row(two, "piece.ode-to-joy-hands")?.status).toBe("next");
  });

  it("makes the hands piece the current one once no one-hand piece is left", () => {
    const treble = pieces.filter((p) => pieceHandOf(p) === "right").map((p) => p.id);
    const data = pieceCard(
      pieces,
      learner("fluent", { coord: "fluent", completed: treble }),
      graph,
    );
    expect(data?.current?.id).toBe("piece.hot-cross-buns-hands");
    expect(data?.handsCurrent).toBeUndefined();
  });
});
