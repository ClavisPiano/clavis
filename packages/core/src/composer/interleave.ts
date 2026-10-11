import { at } from "../theory/util.js";
import type { Rng } from "../random.js";

export interface Interleavable {
  nodeId: string;
  generator: string;
  isNew: boolean;
}

/** Items of the same type (node plus generator) should not sit next to each other (spec 2). */
export const typeKey = (it: Interleavable): string => `${it.nodeId}|${it.generator}`;

/** Seeded noise added to an item's position when choosing the next one. Keeps priority roughly intact. */
const JITTER = 1.5;

/**
 * Order a block's items for interleaving. Input is due items (most overdue first) followed by
 * new items; the result keeps that priority roughly but:
 *
 * 1. New items are spread evenly through the block rather than clustered at the end.
 * 2. No two neighbours share a type whenever that is possible. The greedy pass checks, before each
 *    pick, that the remaining multiset can still be arranged without adjacency (a type with m
 *    items among R needs m <= ceil(R / 2), or floor(R / 2) when it matches the last pick).
 * 3. Ties are broken with the seeded `rng`, so output is deterministic for a given seed.
 */
export function interleave<T extends Interleavable>(items: readonly T[], rng: Rng): T[] {
  const N = items.length;
  if (N <= 1) return [...items];

  const due = items.filter((i) => !i.isNew);
  const fresh = items.filter((i) => i.isNew);
  const slots: (T | undefined)[] = new Array<T | undefined>(N).fill(undefined);
  fresh.forEach((it, j) => {
    slots[Math.floor(((j + 0.5) * N) / fresh.length)] = it;
  });
  let d = 0;
  const ordered: T[] = slots.map((s) => s ?? at(due, d++));

  const pool = ordered.map((item, idx) => ({ item, idx, key: typeKey(item) }));
  const counts = new Map<string, number>();
  for (const p of pool) counts.set(p.key, (counts.get(p.key) ?? 0) + 1);

  const feasible = (remaining: number, prev: string | undefined): boolean => {
    for (const [k, m] of counts) {
      if (m === 0) continue;
      const limit = k === prev ? Math.floor(remaining / 2) : Math.ceil(remaining / 2);
      if (m > limit) return false;
    }
    return true;
  };

  const out: T[] = [];
  let prev: string | undefined;
  while (pool.length > 0) {
    const open = pool.filter((p) => p.key !== prev);
    let choices = pool;
    if (open.length > 0) {
      const good = open.filter((p) => {
        counts.set(p.key, (counts.get(p.key) ?? 0) - 1);
        const ok = feasible(pool.length - 1, p.key);
        counts.set(p.key, (counts.get(p.key) ?? 0) + 1);
        return ok;
      });
      if (good.length > 0) choices = good;
      else {
        // Unavoidable adjacency ahead: spend the most plentiful type now to limit the damage.
        const top = Math.max(...open.map((p) => counts.get(p.key) ?? 0));
        choices = open.filter((p) => (counts.get(p.key) ?? 0) === top);
      }
    }
    let best = at(choices, 0);
    let bestScore = Infinity;
    for (const p of choices) {
      const score = p.idx + rng.next() * JITTER;
      if (score < bestScore) {
        bestScore = score;
        best = p;
      }
    }
    pool.splice(pool.indexOf(best), 1);
    counts.set(best.key, (counts.get(best.key) ?? 0) - 1);
    out.push(best.item);
    prev = best.key;
  }
  return out;
}
