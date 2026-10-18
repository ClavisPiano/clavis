import { describe, expect, it } from "vitest";
import {
  GENERATORS,
  createPieceHands,
  createRng,
  describeGraphError,
  getGenerator,
  isNodeEnabled,
  validateGraph,
  type GeneratorId,
} from "@clavis/core";
import { loadGraph, loadPieces, parseGraph } from "./index";

const SPEC_IDS = [
  // EAR
  "ear.degrees.major.135",
  "ear.rhythm.echo",
  "ear.degrees.major.diatonic",
  "ear.cells.major.2-4",
  "ear.bass.I-IV-V-vi",
  "ear.quality.triad",
  "ear.prog.core",
  "ear.cadence",
  "ear.degrees.minor",
  "ear.prog.minor",
  "ear.prog.colour",
  "ear.real.phrase",
  // READ
  "read.bass.landmarks",
  "read.rhythm.basic",
  "read.bass.steps",
  "read.bass.skips",
  "read.bass.intervals",
  "read.bass.chords",
  "read.grand.2line",
  "read.grand.sight",
  "read.minor.accidentals",
  "read.treble.landmarks",
  "read.treble.steps",
  "read.treble.skips",
  // HANDS
  "hands.lh.triads.root",
  "hands.lh.inversions",
  "hands.lh.broken",
  "hands.lh.pop",
  "hands.coord.basic",
  "hands.coord.moving",
  "hands.minor.leadingTone",
  // BYEAR
  "byear.melody.simple",
  "byear.harmonise",
  "byear.full.phrase",
  // APPLY (MP)
  "apply.pieces",
  "apply.piece-ear",
  // APPLY (T5.6)
  "apply.pieces-hands",
];

describe("v1 skill graph", () => {
  const graph = loadGraph();

  it("parses and validates with no errors", () => {
    const r = validateGraph(graph);
    expect(r.errors.map(describeGraphError)).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("has 37 nodes with exactly the spec ids, the treble nodes and the pieces nodes", () => {
    expect(graph.nodes).toHaveLength(37);
    expect(graph.nodes.map((n) => n.id).sort()).toEqual([...SPEC_IDS].sort());
  });

  it("has the expected strand counts", () => {
    const count = (s: string) => graph.nodes.filter((n) => n.strand === s).length;
    expect([count("EAR"), count("READ"), count("HANDS"), count("BYEAR"), count("APPLY")]).toEqual([
      12, 12, 7, 3, 3,
    ]);
  });

  it("encodes the R10 prerequisites", () => {
    const get = (id: string) => graph.nodes.find((n) => n.id === id);
    expect(get("read.minor.accidentals")?.prerequisites).toEqual([
      "read.bass.skips",
      "ear.degrees.minor",
    ]);
    expect(get("hands.minor.leadingTone")?.prerequisites).toEqual([
      "hands.lh.triads.root",
      "ear.degrees.minor",
    ]);
  });

  it("marks EAR and BYEAR key independent and HANDS key dependent", () => {
    for (const n of graph.nodes) {
      if (n.strand === "EAR" || n.strand === "BYEAR") expect(n.keyDependent).toBe(false);
      if (n.strand === "HANDS") expect(n.keyDependent).toBe(true);
    }
  });

  it("lists every generator once and implements exactly the core registry", () => {
    expect(graph.generators).toHaveLength(24);
    const implemented = graph.generators.filter((g) => g.implemented).map((g) => g.id);
    // `pieceLine`, `pieceEar` and `pieceHands` are built over the piece library, so the app
    // injects them; the core registry has the rest.
    const injected = ["pieceLine", "pieceEar", "pieceHands"];
    expect(implemented.sort()).toEqual([...Object.keys(GENERATORS), ...injected].sort());
    for (const id of implemented.filter((i) => !injected.includes(i))) {
      expect(getGenerator(id)).toBeDefined();
    }
  });

  it("enables the ear M2 nodes and the twelve reading nodes", () => {
    const enabled = graph.nodes.filter((n) => isNodeEnabled(n, graph.generators)).map((n) => n.id);
    for (const id of [
      "ear.degrees.major.135",
      "ear.rhythm.echo",
      "ear.degrees.major.diatonic",
      "ear.cells.major.2-4",
      "ear.degrees.minor",
    ]) {
      expect(enabled).toContain(id);
    }
    // R18: bassNoteRead covers five nodes, rhythmRead one. T5.10: bassChordRead the bass chords.
    // T5.11: sightLine the two grand-staff nodes.
    expect(enabled.filter((id) => id.startsWith("read.")).sort()).toEqual([
      "read.bass.chords",
      "read.bass.intervals",
      "read.bass.landmarks",
      "read.bass.skips",
      "read.bass.steps",
      "read.grand.2line",
      "read.grand.sight",
      "read.minor.accidentals",
      "read.rhythm.basic",
      "read.treble.landmarks",
      "read.treble.skips",
      "read.treble.steps",
    ]);
    // MP: pieces, read and by ear, are the APPLY nodes. T5.6: and pieces for both hands.
    expect(enabled.filter((id) => id.startsWith("apply."))).toEqual([
      "apply.pieces",
      "apply.piece-ear",
      "apply.pieces-hands",
    ]);
    // T5.3: lhPattern enables the root-position chord node. T5.7: lhPatternVariants enables
    // inversions, broken and pop. The minor leading-tone node has its own unimplemented generator.
    // T5.5: coordTask enables hands.coord.basic; hands.coord.moving moved to coordTaskMoving.
    expect(enabled.filter((id) => id.startsWith("hands."))).toEqual([
      "hands.lh.triads.root",
      "hands.lh.inversions",
      "hands.lh.broken",
      "hands.lh.pop",
      "hands.coord.basic",
    ]);
    expect(enabled).not.toContain("hands.minor.leadingTone");
    // T7.2: the melody stage is the only by-ear task that exists. Harmonising and real recordings
    // have their own generators, so `ear.real.phrase` and the later BYEAR nodes stay disabled.
    expect(enabled.filter((id) => id.startsWith("byear."))).toEqual(["byear.melody.simple"]);
    expect(enabled).not.toContain("ear.real.phrase");
    expect(
      enabled.every(
        (id) =>
          id.startsWith("ear.") ||
          id.startsWith("read.") ||
          id.startsWith("apply.") ||
          id.startsWith("hands.") ||
          id === "byear.melody.simple",
      ),
    ).toBe(true);
  });

  it("serves the left-hand pattern nodes, leaving the minor one disabled (T5.3, T5.7)", () => {
    const variants = graph.nodes.filter((n) => n.itemGenerators.includes("lhPatternVariants"));
    expect(variants.map((n) => n.id)).toEqual([
      "hands.lh.inversions",
      "hands.lh.broken",
      "hands.lh.pop",
    ]);
    expect(
      graph.nodes.filter((n) => n.itemGenerators.includes("lhPatternMinor")).map((n) => n.id),
    ).toEqual(["hands.minor.leadingTone"]);
    expect(
      graph.nodes.filter((n) => n.itemGenerators.includes("lhPattern")).map((n) => n.id),
    ).toEqual(["hands.lh.triads.root"]);
    for (const id of ["lhPattern", "lhPatternVariants", "lhPatternMinor"]) {
      const info = graph.generators.find((g) => g.id === id);
      expect(info?.requires).toContain("polyphonic");
      expect(info?.awayEligible).toBe(false);
    }
    expect(graph.generators.find((g) => g.id === "lhPatternVariants")?.implemented).toBe(true);
    expect(graph.generators.find((g) => g.id === "lhPatternMinor")?.implemented).toBe(false);
    for (const id of ["lhPattern", "lhPatternVariants"]) {
      expect(graph.generators.find((g) => g.id === id)?.requires).toContain("notation");
    }
  });

  it("serves hands together over block chords only, MIDI only and never Away (T5.5)", () => {
    const users = (id: GeneratorId) =>
      graph.nodes.filter((n) => n.itemGenerators.includes(id)).map((n) => n.id);
    expect(users("coordTask")).toEqual(["hands.coord.basic"]);
    expect(users("coordTaskMoving")).toEqual(["hands.coord.moving"]);
    const coord = graph.generators.find((g) => g.id === "coordTask");
    expect(coord?.implemented).toBe(true);
    expect(coord?.awayEligible).toBe(false);
    expect(coord?.requires).toEqual(expect.arrayContaining(["polyphonic", "notation"]));
    expect(graph.generators.find((g) => g.id === "coordTaskMoving")?.implemented).toBe(false);
    const basic = graph.nodes.find((n) => n.id === "hands.coord.basic");
    if (basic === undefined) throw new Error("no hands.coord.basic");
    // 3 families x 27 progressions x 3 melodies.
    expect(getGenerator("coordTask").listItems(basic)).toHaveLength(243);
  });

  it("serves hands-together pieces from their own node, MIDI only and never Away (T5.6)", () => {
    const users = graph.nodes.filter((n) => n.itemGenerators.includes("pieceHands"));
    expect(users.map((n) => [n.id, n.strand])).toEqual([["apply.pieces-hands", "APPLY"]]);
    const hands = graph.generators.find((g) => g.id === "pieceHands");
    expect(hands?.implemented).toBe(true);
    expect(hands?.awayEligible).toBe(false);
    expect(hands?.requires).toEqual(expect.arrayContaining(["polyphonic", "notation"]));
    // Every phrase of the five hands pieces is an item, played as a two-hand performance.
    const node = users[0];
    if (node === undefined) throw new Error("no apply.pieces-hands");
    const gen = createPieceHands(loadPieces());
    const items = gen.listItems(node);
    expect(items).toHaveLength(2 + 4 + 4 + 2 + 6);
    for (const params of items) {
      const inst = gen.generate(node, params, { rng: createRng(1), mode: "instrument" });
      const play = inst.expected.play;
      expect(play?.kind).toBe("performance");
      if (play?.kind !== "performance") continue;
      expect(new Set(play.notes.map((n) => n.hand))).toEqual(new Set(["lh", "rh"]));
    }
  });

  it("every enabled node's generators can enumerate and generate items", () => {
    for (const node of graph.nodes) {
      for (const g of node.itemGenerators) {
        const gen = GENERATORS[g];
        if (gen === undefined) continue;
        const items = gen.listItems(node);
        const item = items[0];
        if (item === undefined) throw new Error(`no items for ${node.id}`);
        const inst = gen.generate(node, item, {
          rng: createRng(1),
          mode: "instrument",
        });
        expect(inst.nodeId).toBe(node.id);
      }
    }
  });

  it("no item of any enabled generator has a sing target, and every item has a play target (R29)", () => {
    for (const node of graph.nodes) {
      for (const g of node.itemGenerators) {
        const gen = GENERATORS[g];
        if (gen === undefined) continue;
        for (const params of gen.listItems(node)) {
          for (const mode of ["instrument", "away"] as const) {
            const inst = gen.generate(node, params, { rng: createRng(3), mode });
            expect(inst.expected.sing, `${node.id} ${g}`).toBeUndefined();
            expect(inst.expected.play, `${node.id} ${g}`).toBeDefined();
          }
        }
      }
    }
    // Every item of every enabled generator, twice: this grows with the graph (about 4 s locally).
  }, 30_000);

  it("gives latency-gated nodes a matching target", () => {
    for (const n of graph.nodes) {
      expect(n.mastery.maxMedianLatencyMs).toBe(n.targetLatencyMs);
    }
  });
});

describe("parseGraph", () => {
  it("throws a readable message on schema errors", () => {
    expect(() => parseGraph({ contentVersion: "x", nodes: [{ id: "a" }], generators: [] })).toThrow(
      /Invalid skill graph content[\s\S]*nodes\.0/,
    );
  });
});
