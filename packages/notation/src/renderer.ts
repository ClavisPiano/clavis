import type { ScoreSpec } from "@clavis/core";

/** Draws a ScoreSpec to SVG. Implementations: Verovio (later), StubRenderer (tests). */
export interface NotationRenderer {
  preload(): Promise<void>;
  render(score: ScoreSpec, opts: { widthPx: number }): Promise<{ svg: string; noteIds: string[] }>;
}
