export type {
  PlacementAttempt,
  PlacementItem,
  PlacementPlan,
  PlacementSection,
  PlacementStage,
  PlacementState,
  PlacementStep,
  StageOutcome,
} from "./types.js";
export { mergePlacement, placementResults } from "./evaluate.js";
export { nextPlacementStep, placementPlan, type PlacementPlanOptions } from "./plan.js";
