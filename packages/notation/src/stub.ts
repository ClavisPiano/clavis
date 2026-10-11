import type { ScoreSpec } from "@clavis/core";
import type { NotationRenderer } from "./renderer.js";

/** Deterministic renderer for tests: one `<g id="nX">` per note, no real engraving. */
export class StubRenderer implements NotationRenderer {
  preload(): Promise<void> {
    return Promise.resolve();
  }

  render(score: ScoreSpec, opts: { widthPx: number }): Promise<{ svg: string; noteIds: string[] }> {
    const noteIds: string[] = [];
    for (const staff of score.staves)
      for (const measure of staff.measures)
        for (const el of measure) if (el.kind === "note") noteIds.push(el.id);
    const groups = noteIds
      .map(
        (id, i) =>
          `<g id="${id}"><rect x="${String(10 + i * 20)}" y="10" width="12" height="12"/></g>`,
      )
      .join("");
    const w = String(opts.widthPx);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="100" viewBox="0 0 ${w} 100">${groups}</svg>`;
    return Promise.resolve({ svg, noteIds });
  }
}
