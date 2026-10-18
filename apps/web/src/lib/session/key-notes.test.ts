import { getGenerator } from "@clavis/core";
import { loadGraph } from "@clavis/content";
import { createRng } from "@clavis/core";
import { describe, expect, it } from "vitest";
import { answerLine, keyNotes } from "./key-notes";

const graph = loadGraph();
const node = (id: string) => {
  const n = graph.nodes.find((x) => x.id === id);
  if (!n) throw new Error(id);
  return n;
};

function degreeItem(nodeId: string, degree: number, tonic: string, mode: "major" | "minor") {
  return getGenerator("degreeId").generate(
    node(nodeId),
    { degree },
    {
      rng: createRng(1),
      preferredKey: { tonic, mode },
      mode: "instrument",
    },
  );
}

describe("keyNotes", () => {
  it("names the home chord in the key of the day", () => {
    const item = degreeItem("ear.degrees.major.135", 3, "G", "major");
    expect(keyNotes(item, node("ear.degrees.major.135"))).toEqual({
      key: "G major",
      notes: [
        { label: "1", note: "G" },
        { label: "3", note: "B" },
        { label: "5", note: "D" },
      ],
    });
  });

  it("spells flats and sharps as the key does", () => {
    const item = degreeItem("ear.degrees.major.135", 1, "Eb", "major");
    expect(keyNotes(item, node("ear.degrees.major.135"))?.notes.map((n) => n.note)).toEqual([
      "Eb",
      "G",
      "Bb",
    ]);
    const sharp = degreeItem("ear.degrees.major.135", 1, "F#", "major");
    expect(keyNotes(sharp, node("ear.degrees.major.135"))?.notes.map((n) => n.note)).toEqual([
      "F#",
      "A#",
      "C#",
    ]);
  });

  it("names minor degrees from the minor scale itself", () => {
    const item = degreeItem("ear.degrees.minor", 3, "A", "minor");
    const notes = keyNotes(item, node("ear.degrees.minor"))?.notes ?? [];
    expect(notes.find((n) => n.note === "C")?.label).toBe("3");
  });

  it("is absent for items that are not degrees", () => {
    const cell = getGenerator("cellEcho").generate(
      node("ear.cells.major.2-4"),
      { cell: [1, 2, 3] },
      { rng: createRng(1), mode: "instrument" },
    );
    expect(keyNotes(cell, node("ear.cells.major.2-4"))).toBeUndefined();
  });
});

describe("answerLine", () => {
  it("says which note it was, in the key", () => {
    expect(answerLine(degreeItem("ear.degrees.major.135", 3, "G", "major"))).toBe(
      "The note was 3, which is B in G major.",
    );
  });

  it("lists the notes of a cell", () => {
    const cell = getGenerator("cellEcho").generate(
      node("ear.cells.major.2-4"),
      { cell: [1, 2, 3] },
      {
        rng: createRng(1),
        preferredKey: { tonic: "G", mode: "major" },
        mode: "instrument",
      },
    );
    expect(answerLine(cell)).toBe("The notes were 1 2 3, which is G A B in G major.");
  });
});
