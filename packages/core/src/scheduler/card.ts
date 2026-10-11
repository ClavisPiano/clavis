import { State, type Card } from "ts-fsrs";

/** Plain JSON-serialisable FSRS card. All times are epoch milliseconds. */
export type CardPhase = "new" | "learning" | "review" | "relearning";

export interface CardState {
  due: number;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  reps: number;
  lapses: number;
  state: CardPhase;
  lastReview?: number;
  learningSteps?: number;
}

const PHASE_TO_STATE: Record<CardPhase, State> = {
  new: State.New,
  learning: State.Learning,
  review: State.Review,
  relearning: State.Relearning,
};

const STATE_TO_PHASE: Record<State, CardPhase> = {
  [State.New]: "new",
  [State.Learning]: "learning",
  [State.Review]: "review",
  [State.Relearning]: "relearning",
};

export function toFsrsCard(card: CardState): Card {
  const out: Card = {
    due: new Date(card.due),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsedDays,
    scheduled_days: card.scheduledDays,
    learning_steps: card.learningSteps ?? 0,
    reps: card.reps,
    lapses: card.lapses,
    state: PHASE_TO_STATE[card.state],
  };
  if (card.lastReview !== undefined) out.last_review = new Date(card.lastReview);
  return out;
}

export function fromFsrsCard(card: Card): CardState {
  const out: CardState = {
    due: card.due.getTime(),
    stability: card.stability,
    difficulty: card.difficulty,
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- kept for exact round-trip
    elapsedDays: card.elapsed_days,
    scheduledDays: card.scheduled_days,
    reps: card.reps,
    lapses: card.lapses,
    state: STATE_TO_PHASE[card.state],
    learningSteps: card.learning_steps,
  };
  if (card.last_review) out.lastReview = card.last_review.getTime();
  return out;
}
