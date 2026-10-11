import { describe, expect, it } from "vitest";
import {
  GENERATORS,
  createRng,
  describeGraphError,
  getGenerator,
  isNodeEnabled,
  validateGraph,
} from "@clavis/core";
import { loadGraph, parseGraph } from "./index";

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
];

describe("v1 skill graph", () => {
  const graph = loadGraph();

  it("parses and validates with no errors", () => {
    const r = validateGraph(graph);
    expect(r.errors.map(describeGraphError)).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("has 31 nodes with exactly the spec ids", () => {
    expect(graph.nodes).toHaveLength(31);
    expect(graph.nodes.map((n) => n.id).sort()).toEqual([...SPEC_IDS].sort());
  });

  it("has the expected strand counts", () => {
    const count = (s: string) => graph.nodes.filter((n) => n.strand === s).length;
    expect([count("EAR"), count("READ"), count("HANDS"), count("BYEAR")]).toEqual([12, 9, 7, 3]);
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
    expect(graph.generators).toHaveLength(15);
    const implemented = graph.generators.filter((g) => g.implemented).map((g) => g.id);
    expect(implemented.sort()).toEqual(Object.keys(GENERATORS).sort());
    for (const id of implemented) expect(getGenerator(id)).toBeDefined();
  });

  it("enables the ear M2 nodes and the six reading nodes", () => {
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
    // R18: bassNoteRead covers five nodes, rhythmRead one. Grand staff and chords wait for M5.
    expect(enabled.filter((id) => id.startsWith("read.")).sort()).toEqual([
      "read.bass.intervals",
      "read.bass.landmarks",
      "read.bass.skips",
      "read.bass.steps",
      "read.minor.accidentals",
      "read.rhythm.basic",
    ]);
    expect(enabled.every((id) => id.startsWith("ear.") || id.startsWith("read."))).toBe(true);
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
          voiceRange: { low: 48, high: 72 },
          mode: "instrument",
        });
        expect(inst.nodeId).toBe(node.id);
      }
    }
  });

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
