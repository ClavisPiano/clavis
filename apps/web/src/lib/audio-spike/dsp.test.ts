import { describe, expect, it } from "vitest";
import { adaptiveThreshold, findGaps, firstSpike, median, peakAbs, rms, toDb } from "./dsp";

describe("dsp", () => {
  it("rms of a constant and of a square wave", () => {
    expect(rms([])).toBe(0);
    expect(rms([0.5, 0.5, 0.5])).toBeCloseTo(0.5);
    expect(rms([1, -1, 1, -1])).toBeCloseTo(1);
  });

  it("rms of a sine is amplitude over sqrt 2", () => {
    const buf = Float32Array.from(
      { length: 1000 },
      (_, i) => 0.8 * Math.sin((2 * Math.PI * i) / 100),
    );
    expect(rms(buf)).toBeCloseTo(0.8 / Math.SQRT2, 3);
  });

  it("peakAbs sees negative peaks", () => {
    expect(peakAbs([0.1, -0.7, 0.3])).toBeCloseTo(0.7);
    expect(peakAbs([])).toBe(0);
  });

  it("median handles odd, even, empty and unsorted input", () => {
    expect(median([])).toBeUndefined();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([7])).toBe(7);
  });

  it("toDb is 0 at full scale, -6 dB at half, finite at silence", () => {
    expect(toDb(1)).toBeCloseTo(0);
    expect(toDb(0.5)).toBeCloseTo(-6.02, 1);
    expect(toDb(0)).toBe(-120);
  });

  it("firstSpike respects the threshold and notBefore", () => {
    const frames = [
      { t: 0, level: 0.5 },
      { t: 1, level: 0.01 },
      { t: 2, level: 0.2 },
      { t: 3, level: 0.9 },
    ];
    expect(firstSpike(frames, 0.1)?.t).toBe(0);
    expect(firstSpike(frames, 0.1, 1)?.t).toBe(2);
    expect(firstSpike(frames, 0.95)).toBeUndefined();
    expect(firstSpike(frames, 0.2, 2)?.t).toBe(3);
  });

  it("adaptiveThreshold has a floor", () => {
    expect(adaptiveThreshold(0)).toBe(0.02);
    expect(adaptiveThreshold(0.1)).toBeCloseTo(0.4);
  });

  it("findGaps reports only large gaps", () => {
    expect(findGaps([0, 1000, 2000], 1500)).toEqual([]);
    expect(findGaps([0, 1000, 6000, 7000], 1500)).toEqual([{ atMs: 6000, gapMs: 5000 }]);
  });
});
