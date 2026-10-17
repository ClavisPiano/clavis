import { PieceSchema, ScoreSpecSchema } from "@clavis/core";
import { estimateDifficulty, importMusicXml, importMxl, splitPhrases } from "@clavis/notation";
import { IMPORT_GOLDENS, buildMxl, toMusicXml } from "@clavis/notation/testing";
import { describe, expect, it } from "vitest";

// notation cannot import core at runtime, so the importer output is validated against the core zod
// schema here, where both packages are available.

describe("MusicXML import against the core schema", () => {
  it.each(IMPORT_GOLDENS)(
    "$name validates and matches the golden",
    ({ xml, options, expected }) => {
      expect(ScoreSpecSchema.parse(expected)).toEqual(expected);
      const imported = importMusicXml(xml, options);
      expect(ScoreSpecSchema.parse(imported)).toEqual(expected);
    },
  );

  it("validates an MXL import", () => {
    const golden = IMPORT_GOLDENS[0];
    if (golden === undefined) throw new Error("no golden");
    expect(ScoreSpecSchema.parse(importMxl(buildMxl(golden.xml)))).toEqual(golden.expected);
  });

  it("round-trips a spec through toMusicXml and the schema", () => {
    for (const { expected } of IMPORT_GOLDENS) {
      expect(ScoreSpecSchema.parse(importMusicXml(toMusicXml(expected)))).toEqual(expected);
    }
  });

  it("gives phrases and a difficulty that a Piece accepts", () => {
    const score = ScoreSpecSchema.parse(importMusicXml(IMPORT_GOLDENS[0]?.xml ?? ""));
    const phrases = splitPhrases(score);
    const difficulty = estimateDifficulty(score);
    const result = PieceSchema.safeParse({
      id: "piece.imported",
      title: "Imported",
      source: "Test",
      score,
      phrases,
      requiredNodeIds: ["read.treble.landmarks"],
      difficulty,
    });
    expect(result.success).toBe(true);
  });
});
