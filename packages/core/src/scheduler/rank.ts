import type { CardState } from "./card.js";

const MS_PER_DAY = 86_400_000;

/**
 * How overdue a card is relative to its stability: `(now - due) / max(stability
 * in ms, 1 day)`. Negative when not yet due.
 */
export function overdueness(card: CardState, now: number): number {
  return (now - card.due) / Math.max(card.stability * MS_PER_DAY, MS_PER_DAY);
}

/**
 * Due items only, most overdue relative to stability first (spec 6.4). Ties
 * break on `itemId` when present, else input order, so output is deterministic.
 */
export function rankDue<T extends { card: CardState; itemId?: string }>(
  items: readonly T[],
  now: number,
): T[] {
  return items
    .map((item, index) => ({ item, index, score: overdueness(item.card, now) }))
    .filter((e) => e.item.card.due <= now)
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      const ka = a.item.itemId;
      const kb = b.item.itemId;
      if (ka !== undefined && kb !== undefined && ka !== kb) return ka < kb ? -1 : 1;
      return a.index - b.index;
    })
    .map((e) => e.item);
}
