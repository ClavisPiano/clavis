import { describe, expect, it } from "vitest";
import { createRng } from "./random.js";

describe("createRng", () => {
  it("is deterministic per seed and differs across seeds", () => {
    const a = createRng(42);
    const b = createRng(42);
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).toEqual(seqB);
    const c = createRng(43);
    expect(Array.from({ length: 20 }, () => c.next())).not.toEqual(seqA);
  });

  it("next is in [0,1), int is inclusive, pick returns members", () => {
    const r = createRng(7);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const x = r.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      seen.add(r.int(3, 6));
    }
    expect([...seen].sort()).toEqual([3, 4, 5, 6]);
    expect(["a", "b"]).toContain(r.pick(["a", "b"]));
    expect(() => r.pick([])).toThrow(RangeError);
    expect(() => r.int(2, 1)).toThrow(RangeError);
  });
});
