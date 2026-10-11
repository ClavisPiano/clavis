import { createScheduler } from "../scheduler/scheduler.js";
import type { CardState } from "../scheduler/card.js";

const scheduler = createScheduler();

/**
 * Practice order (T2.15): every card regardless of due date, weakest first. Weakest means the
 * lowest current retrievability, then the least recently reviewed, then item id so the order is
 * deterministic. Input order is not used.
 */
export function rankWeakest<T extends { card: CardState; itemId: string }>(
  items: readonly T[],
  now: number,
): T[] {
  return items
    .map((item) => ({
      item,
      r: scheduler.retrievability(item.card, now),
      last: item.card.lastReview ?? item.card.due,
    }))
    .sort((a, b) => {
      if (a.r !== b.r) return a.r - b.r;
      if (a.last !== b.last) return a.last - b.last;
      return a.item.itemId < b.item.itemId ? -1 : a.item.itemId > b.item.itemId ? 1 : 0;
    })
    .map((e) => e.item);
}
