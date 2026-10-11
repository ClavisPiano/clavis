/**
 * Injected source of randomness. Core never calls `Math.random()`; callers
 * pass an implementation (crypto-backed in production, seeded in tests).
 */
export type RandomBytes = (n: number) => Uint8Array;

/** Injected clock: milliseconds since the Unix epoch. */
export type Clock = () => number;

/** Seeded deterministic PRNG for item generation. Not for security; use `RandomBytes` for ids. */
export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max], both inclusive. */
  int(min: number, max: number): number;
  /** Uniform element of a non-empty array. */
  pick<T>(items: readonly T[]): T;
}

/** mulberry32: small, fast, deterministic for a given integer seed. */
export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => {
    if (!Number.isInteger(min) || !Number.isInteger(max) || min > max)
      throw new RangeError(`bad int range ${String(min)}..${String(max)}`);
    return min + Math.floor(next() * (max - min + 1));
  };
  const pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) throw new RangeError("pick from empty array");
    return items[int(0, items.length - 1)] as T;
  };
  return { next, int, pick };
}
