import type { ItemParams } from "../items/types.js";

/** A placement result for one node (the `placement.completed` event vocabulary, R5). */
export type PlacementState = "mastered" | "fluent" | "available";

/** HANDS (spec 4 step 3, R27) runs only with polyphonic input (MIDI), so a plan may lack it. */
export type PlacementSection = "EAR" | "READ" | "HANDS";

/** One item to present. `itemId` is the real generator item id, so T3.16 can generate an instance. */
export interface PlacementItem {
  section: PlacementSection;
  stageId: string;
  nodeId: string;
  generator: "degreeId" | "bassNoteRead" | "lhPattern" | "coordTask";
  itemId: string;
  params: ItemParams;
  /** EAR items: the scale degree. */
  degree?: number;
  /** READ items: the staff position text, such as `C2`. */
  pos?: string;
}

/** A stage tests one node. Stages of a section run in order. */
export interface PlacementStage {
  id: string;
  section: PlacementSection;
  nodeId: string;
  items: PlacementItem[];
}

export interface PlacementPlan {
  /** In order: EAR, READ, then HANDS when the input is polyphonic. */
  stages: PlacementStage[];
}

/** The minimum a caller records per answered item, in presentation order. */
export interface PlacementAttempt {
  itemId: string;
  nodeId: string;
  correct: boolean;
  latencyMs: number;
  targetLatencyMs: number;
}

export interface StageOutcome {
  stageId: string;
  nodeId: string;
  section: PlacementSection;
  /** Raw (uncapped) result of the stage. */
  state: PlacementState;
}

export type PlacementStep =
  | {
      kind: "item";
      item: PlacementItem;
      /** True for the first item of a stage. */
      stageStart: boolean;
      /** Stages completed so far, in order. */
      completed: StageOutcome[];
    }
  | {
      kind: "done";
      completed: StageOutcome[];
      /** Stages that were not run because an earlier stage of the section stopped it. */
      skippedStageIds: string[];
    };
