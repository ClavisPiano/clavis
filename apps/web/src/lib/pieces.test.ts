import { readFileSync } from "node:fs";
import { createScheduler, foldEvents, type LearningEvent } from "@clavis/core";
import { loadGraph, loadPieces } from "@clavis/content";
import { describe, expect, it } from "vitest";
import { buildImportEvent, convertFile } from "./piece-import";
import { appGenerators, appPieces, generatorFor, pieceInputs } from "./pieces";

const graph = loadGraph();
const fold = (events: LearningEvent[]) =>
  foldEvents(events, { graph, scheduler: createScheduler() });

const converted = convertFile(
  "musicxml",
  new Uint8Array(readFileSync(new URL("../../e2e/fixtures/little-tune.musicxml", import.meta.url))),
  { partIndex: 0, staff: 1 },
);
if (!converted.ok) throw new Error(converted.message);
const imported = buildImportEvent({
  eventId: "01JBX00000000000000000D001",
  pieceUlid: "01JBX00000000000000000D002",
  deviceId: "dev",
  at: 1_760_000_000_000,
  title: "Little Tune",
  kind: "musicxml",
  partIndex: 0,
  staff: 1,
  candidate: converted.candidate,
});

describe("app pieces", () => {
  it("is the library alone without imports", () => {
    const state = fold([]);
    expect(appPieces(state).map((p) => p.id)).toEqual(loadPieces().map((p) => p.id));
    expect(appPieces().map((p) => p.id)).toEqual(loadPieces().map((p) => p.id));
  });

  it("puts an import first and generates its phrases from the learner state", () => {
    const state = fold([imported]);
    const pieces = appPieces(state);
    expect(pieces[0]?.id).toBe(imported.pieceId);
    expect(pieces).toHaveLength(loadPieces().length + 1);
    expect(pieceInputs(state).pieces).toBe(pieces);

    const node = graph.nodes.find((n) => n.id === "apply.pieces");
    if (node === undefined) throw new Error("no pieces node");
    const item = generatorFor("pieceLine", state).generate(
      node,
      { piece: imported.pieceId, phrase: 1 },
      { rng: () => 0.5 } as never,
    );
    expect(item.display?.staves[0]?.measures).toHaveLength(2);
    expect(item.itemId).toContain(imported.pieceId);
    // Without the import in the state the same phrase is unknown, so a stale generator never answers.
    expect(() =>
      generatorFor("pieceLine", fold([])).generate(node, { piece: imported.pieceId, phrase: 1 }, {
        rng: () => 0.5,
      } as never),
    ).toThrow(RangeError);
  });

  it("rebuilds only when the imported set changes object", () => {
    const state = fold([imported]);
    expect(appGenerators(state)).toBe(appGenerators(state));
    expect(appPieces(state)).toBe(appPieces(state));
  });
});
