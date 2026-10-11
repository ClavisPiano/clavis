import type { ScoreSpec } from "@clavis/core";
import { describe, expect, it } from "vitest";
import { StubRenderer } from "./stub.js";

// notation may only use `import type` from core, so the score is written out here.
const quarter = { value: 4, dots: 0 } as const;
const pitches = [{ step: "B", alter: 0, octave: 4 }] as const;
const score: ScoreSpec = {
  staves: [
    {
      clef: "percussion",
      lines: 1,
      measures: [
        [
          { kind: "note", id: "n1", pitches: [...pitches], duration: quarter },
          { kind: "rest", duration: quarter },
          { kind: "note", id: "n2", pitches: [...pitches], duration: quarter },
        ],
        [{ kind: "note", id: "n3", pitches: [...pitches], duration: quarter }],
      ],
    },
  ],
  key: null,
  meter: { beats: 4, beatValue: 4 },
};

describe("StubRenderer", () => {
  it("renders one group per note id and returns all ids in order", async () => {
    const r = new StubRenderer();
    await r.preload();
    const out = await r.render(score, { widthPx: 300 });
    expect(out.noteIds).toEqual(["n1", "n2", "n3"]);
    for (const id of out.noteIds) expect(out.svg).toContain(`<g id="${id}">`);
    expect(out.svg.match(/<g id=/g)).toHaveLength(3);
  });

  it("is deterministic", async () => {
    const r = new StubRenderer();
    expect(await r.render(score, { widthPx: 300 })).toEqual(
      await r.render(score, { widthPx: 300 }),
    );
  });
});
