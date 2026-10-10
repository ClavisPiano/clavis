import { describe, expect, it } from "vitest";
import { describeGraphError, isNodeEnabled, validateGraph } from "@clavis/core";
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

  it("lists every generator once and ships none implemented", () => {
    expect(graph.generators).toHaveLength(15);
    expect(graph.generators.every((g) => !g.implemented)).toBe(true);
    expect(graph.nodes.some((n) => isNodeEnabled(n, graph.generators))).toBe(false);
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
