import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateLatency } from "./estimate.js";
import { scheduleClickTrack, type ClickContextLike } from "./click.js";
import { detectOnsets } from "./onset.js";
import { LEVEL_PROCESSOR_NAME } from "./level-meter.js";

/** mulberry32: small seeded generator. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Roughly normal noise (sum of 6 uniforms), sd about `sd`. */
function noise(r: () => number, sd: number): number {
  let s = 0;
  for (let i = 0; i < 6; i++) s += r();
  return (s - 3) * sd * Math.sqrt(2);
}

const clicks = Array.from({ length: 12 }, (_, i) => 1000 + i * 600);

function taps(offset: number, sd: number, seed: number): number[] {
  const r = rng(seed);
  return clicks.map((c) => c + offset + noise(r, sd));
}

describe("estimateLatency", () => {
  it("recovers a known offset under jitter", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const e = estimateLatency(clicks, taps(120, 12, seed));
      expect(e.ok).toBe(true);
      expect(Math.abs(e.offsetMs - 120)).toBeLessThan(12);
      expect(e.spreadMs).toBeLessThan(25);
      expect(e.used).toBeGreaterThanOrEqual(7);
    }
  });

  it("is exact with no jitter and drops the two settling pairs", () => {
    const e = estimateLatency(clicks, taps(80, 0, 1));
    expect(e).toEqual({ offsetMs: 80, spreadMs: 0, used: 10, rejected: 2, ok: true });
  });

  it("ignores the settling pairs even when they are wild", () => {
    const obs = taps(100, 0, 1);
    obs[0] = (clicks[0] ?? 0) + 230;
    obs[1] = (clicks[1] ?? 0) - 200;
    const e = estimateLatency(clicks, obs);
    expect(e.offsetMs).toBe(100);
    expect(e.ok).toBe(true);
  });

  it("copes with missing taps", () => {
    const obs = taps(90, 5, 7).filter((_, i) => i !== 4 && i !== 8);
    const e = estimateLatency(clicks, obs);
    expect(e.ok).toBe(true);
    expect(Math.abs(e.offsetMs - 90)).toBeLessThan(8);
    expect(e.used).toBe(8);
  });

  it("keeps one observation per click when taps are doubled", () => {
    const base = taps(90, 4, 9);
    const doubled = base.flatMap((t, i) => (i % 3 === 0 ? [t, t + 60] : [t]));
    const e = estimateLatency(clicks, doubled);
    expect(e.ok).toBe(true);
    expect(Math.abs(e.offsetMs - 90)).toBeLessThan(8);
    expect(e.used).toBe(10);
    expect(e.rejected).toBe(doubled.length - 10);
  });

  it("rejects gross outliers by MAD", () => {
    const obs = taps(100, 3, 11);
    obs[5] = (clicks[5] ?? 0) + 240;
    obs[9] = (clicks[9] ?? 0) - 220;
    const e = estimateLatency(clicks, obs);
    expect(e.ok).toBe(true);
    expect(e.used).toBe(8);
    expect(Math.abs(e.offsetMs - 100)).toBeLessThan(5);
    expect(e.spreadMs).toBeLessThan(6);
  });

  it("drops observations outside the pairing window", () => {
    const e = estimateLatency(clicks, [...taps(100, 0, 1), 99999, 300]);
    expect(e.used).toBe(10);
    expect(e.offsetMs).toBe(100);
  });

  it("is not ok with too few pairs", () => {
    const e = estimateLatency(clicks, taps(100, 2, 3).slice(0, 6));
    expect(e.used).toBe(4);
    expect(e.ok).toBe(false);
  });

  it("is not ok when the spread is too large", () => {
    const r = rng(21);
    const obs = clicks.map((c) => c + (r() - 0.5) * 400);
    const e = estimateLatency(clicks, obs, { madK: 100 });
    expect(e.spreadMs).toBeGreaterThan(40);
    expect(e.ok).toBe(false);
  });

  it("handles no data", () => {
    expect(estimateLatency(clicks, [])).toEqual({
      offsetMs: 0,
      spreadMs: 0,
      used: 0,
      rejected: 0,
      ok: false,
    });
    expect(estimateLatency([], [100]).ok).toBe(false);
  });

  it("estimates a negative offset", () => {
    const e = estimateLatency(clicks, taps(-30, 2, 5));
    expect(e.ok).toBe(true);
    expect(Math.abs(e.offsetMs + 30)).toBeLessThan(4);
  });
});

describe("scheduleClickTrack", () => {
  it("schedules 12 clicks at 100 bpm after a 1 s lead-in", () => {
    const starts: number[] = [];
    const ctx: ClickContextLike = {
      currentTime: 2,
      destination: {},
      createOscillator: () => ({
        type: "",
        frequency: { value: 0 } as never,
        connect: () => undefined,
        start: (t: number) => starts.push(t),
        stop: () => undefined,
      }),
      createGain: () => ({
        gain: {
          value: 1,
          setValueAtTime: () => undefined,
          linearRampToValueAtTime: () => undefined,
          exponentialRampToValueAtTime: () => undefined,
        },
        connect: () => undefined,
      }),
    };
    const { clickTimesMs, endMs } = scheduleClickTrack(ctx);
    expect(clickTimesMs).toHaveLength(12);
    expect(clickTimesMs[0]).toBeCloseTo(3000, 6);
    expect(clickTimesMs[1]).toBeCloseTo(3600, 6);
    expect(starts.map((s) => s * 1000)).toEqual(clickTimesMs);
    expect(endMs).toBeGreaterThan(clickTimesMs[11] ?? 0);
  });
});

describe("detectOnsets", () => {
  const times = Array.from({ length: 400 }, (_, i) => i * 2.9);

  it("finds each click once and ignores the decay", () => {
    const levels = times.map((_, i) => {
      const k = i % 100;
      const base = 0.002;
      if (i >= 20 && k < 14) return 0.6 * Math.exp(-k / 4) + base;
      return base;
    });
    const onsets = detectOnsets(times, levels);
    expect(onsets).toEqual([100, 200, 300].map((i) => times[i]));
  });

  it("ignores a steady noise level", () => {
    const r = rng(3);
    const levels = times.map(() => 0.004 + r() * 0.004);
    expect(detectOnsets(times, levels)).toEqual([]);
  });
});

describe("level worklet", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers under the shared name and posts batched peaks", async () => {
    let name: string | undefined;
    let Ctor: (new () => unknown) | undefined;
    vi.stubGlobal(
      "AudioWorkletProcessor",
      class {
        port = {};
      },
    );
    vi.stubGlobal("registerProcessor", (n: string, c: new () => unknown) => {
      name = n;
      Ctor = c;
    });
    vi.stubGlobal("sampleRate", 48000);
    vi.stubGlobal("currentFrame", 0);
    await import("./level.worklet");
    expect(name).toBe(LEVEL_PROCESSOR_NAME);
    if (!Ctor) throw new Error("not registered");
    const posted: { startFrame: number; peaks: Float32Array }[] = [];
    const proc = new Ctor() as {
      port: { postMessage(m: { startFrame: number; peaks: Float32Array }): void };
      process(i: Float32Array[][]): boolean;
    };
    proc.port = { postMessage: (m) => posted.push(m) };
    const block = new Float32Array(128);
    block[10] = -0.5;
    for (let i = 0; i < 8; i++) {
      vi.stubGlobal("currentFrame", i * 128);
      expect(proc.process([[i === 3 ? block : new Float32Array(128)]])).toBe(true);
    }
    expect(posted).toHaveLength(1);
    expect(posted[0]?.startFrame).toBe(0);
    expect(Array.from(posted[0]?.peaks ?? [])).toEqual([0, 0, 0, 0.5, 0, 0, 0, 0]);
  });
});
