import type { ScoreSpec } from "@clavis/core";

export interface NotationMark {
  noteId: string;
  kind: "target" | "wrong" | "right";
}

/** What the session UI uses to show notation. Implemented over a NotationRenderer in later tasks. */
export interface NotationPort {
  preload(): Promise<void>;
  /** Resolves once the score is painted. */
  show(score: ScoreSpec): Promise<void>;
  highlight(marks: NotationMark[]): void;
  hide(): void;
}
