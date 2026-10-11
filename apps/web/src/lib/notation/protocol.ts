import type { ScoreSpec } from "@clavis/core";

/** Messages between the notation client and its worker. Every request carries an id. */
export type NotationRequest =
  | { id: number; type: "preload" }
  | { id: number; type: "render"; score: ScoreSpec; widthPx: number };

export type NotationResponse =
  | { id: number; type: "ready" }
  | { id: number; type: "rendered"; svg: string; noteIds: string[] }
  | { id: number; type: "error"; message: string };
