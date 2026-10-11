import {
  Rating as FsrsRating,
  createEmptyCard,
  fsrs,
  type FSRSParameters,
  type Grade,
} from "ts-fsrs";
import type { Rating } from "../learning/rating.js";
import { fromFsrsCard, toFsrsCard, type CardState } from "./card.js";

export const DEFAULT_REQUEST_RETENTION = 0.9;
export const DEFAULT_MAXIMUM_INTERVAL_DAYS = 365;

export interface SchedulerOptions {
  requestRetention?: number;
  maximumIntervalDays?: number;
  /**
   * Extra FSRS parameters. Per-learner optimised weights (`w`) plug in here
   * once a learner has ~1000 reviews (spec 5.3); optimisation itself is out of
   * scope for now. `enable_fuzz` is always forced off for determinism.
   */
  params?: Partial<FSRSParameters>;
}

export interface Scheduler {
  newCard(now: number): CardState;
  review(card: CardState, rating: Rating, now: number): CardState;
  /** Probability of recall in 0..1. A new card has retrievability 0. */
  retrievability(card: CardState, now: number): number;
  isDue(card: CardState, now: number): boolean;
}

const GRADES: Record<Rating, Grade> = {
  again: FsrsRating.Again,
  hard: FsrsRating.Hard,
  good: FsrsRating.Good,
  easy: FsrsRating.Easy,
};

export function createScheduler(opts: SchedulerOptions = {}): Scheduler {
  const engine = fsrs({
    ...opts.params,
    request_retention: opts.requestRetention ?? DEFAULT_REQUEST_RETENTION,
    maximum_interval: opts.maximumIntervalDays ?? DEFAULT_MAXIMUM_INTERVAL_DAYS,
    enable_fuzz: false,
  });
  return {
    newCard: (now) => fromFsrsCard(createEmptyCard(new Date(now))),
    review: (card, rating, now) =>
      fromFsrsCard(engine.next(toFsrsCard(card), new Date(now), GRADES[rating]).card),
    retrievability: (card, now) => {
      if (card.state === "new") return 0;
      const r = engine.get_retrievability(toFsrsCard(card), new Date(now), false);
      return Math.min(1, Math.max(0, r));
    },
    isDue: (card, now) => card.due <= now,
  };
}
