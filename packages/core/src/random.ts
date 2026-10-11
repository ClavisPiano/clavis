/**
 * Injected source of randomness. Core never calls `Math.random()`; callers
 * pass an implementation (crypto-backed in production, seeded in tests).
 */
export type RandomBytes = (n: number) => Uint8Array;

/** Injected clock: milliseconds since the Unix epoch. */
export type Clock = () => number;
