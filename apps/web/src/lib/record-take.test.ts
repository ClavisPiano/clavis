import { TAKES, takeTruth, type Take } from "@clavis/audio";
import { describe, expect, it } from "vitest";
import { OnsetDetector, cueAt, noteBeats, scoreNotes, scoreTake } from "./record-take";

function take(slug: string): Take {
  const t = TAKES.find((x) => x.slug === slug);
  if (!t) throw new Error(`no take ${slug}`);
  return t;
}
const bass = take("singles-bass"); // 40 bpm: 1500 ms per beat
const twoHand = take("two-hand-c");

describe("cueAt", () => {
  it("counts in, then shows the note to play now and the next one", () => {
    expect(cueAt(bass, 0)).toEqual({ phase: "count-in", beatsLeft: 4 });
    expect(cueAt(bass, 4499)).toEqual({ phase: "count-in", beatsLeft: 2 });
    // First note on the first beat after the count-in (6000 ms), the next two beats later.
    expect(cueAt(bass, 6000)).toMatchObject({ phase: "play", index: 0, now: "C2", next: "C#2" });
    expect(cueAt(bass, 8999)).toMatchObject({ index: 0, now: "C2" });
    expect(cueAt(bass, 9000)).toMatchObject({ index: 1, now: "C#2", next: "D2", total: 29 });
  });

  it("fills a bar toward the next note", () => {
    expect(cueAt(bass, 6000)).toMatchObject({ towardNext: 0 });
    expect(cueAt(bass, 7500)).toMatchObject({ towardNext: 0.5 });
    expect(noteBeats(twoHand)).toEqual([0, 2, 4, 6, 8, 10, 12, 14]);
  });

  it("is done after the last note has rung", () => {
    const last = 6000 + (28 * 2 + 1.5) * 1500;
    expect(cueAt(bass, last - 1)).toMatchObject({ phase: "play", now: "E4", next: undefined });
    expect(cueAt(bass, last)).toEqual({ phase: "done" });
  });

  it("groups simultaneous notes into one cue", () => {
    expect(cueAt(twoHand, 4000)).toMatchObject({ now: "C3 E3 G3 E4", next: "G4" });
  });
});

describe("scoreTake", () => {
  const truth = takeTruth(bass);

  it("scores a perfect take", () => {
    const s = scoreTake(
      bass,
      truth.map((t) => ({ pitch: t.midi, onsetMs: t.onsetMs + 150 })),
    );
    expect(s).toMatchObject({ total: 29, heard: 29, exact: 29, missed: 0, exactRate: 1 });
  });

  it("separates octave errors, wrong notes and misses", () => {
    const detected = truth.flatMap((t, i) => {
      if (i === 0) return [{ pitch: t.midi + 12, onsetMs: t.onsetMs }]; // octave up
      if (i === 1) return [{ pitch: t.midi + 1, onsetMs: t.onsetMs }]; // wrong
      if (i === 2) return []; // missed
      if (i === 3) return [{ pitch: t.midi, onsetMs: t.onsetMs + 1000 }]; // too late: missed
      return [{ pitch: t.midi, onsetMs: t.onsetMs }];
    });
    const s = scoreTake(bass, detected);
    expect(s).toMatchObject({ heard: 27, exact: 25, octaveErrors: 1, wrong: 1, missed: 2 });
    expect(s.exactRate).toBeCloseTo(25 / 27);
    expect(s.notes[0]).toEqual({ expected: "C2", heard: "C3", verdict: "octave" });
    expect(s.notes[2]).toEqual({ expected: "D2", heard: undefined, verdict: "missed" });
  });

  it("has no rate when nothing was heard", () => {
    expect(scoreTake(bass, []).exactRate).toBeNull();
  });
});

describe("scoreNotes", () => {
  it("scores against heard onsets for self-paced takes", () => {
    const truth = [
      { midi: 36, onsetMs: 1234, offsetMs: 2734 },
      { midi: 37, onsetMs: 4100, offsetMs: 5600 },
    ];
    const s = scoreNotes(truth, [
      { pitch: 36, onsetMs: 1250 },
      { pitch: 49, onsetMs: 4120 },
    ]);
    expect(s).toMatchObject({ heard: 2, exact: 1, octaveErrors: 1 });
  });
});

describe("OnsetDetector", () => {
  const RATE = 22050;

  /** Silence, then decaying low notes struck at `atSec`, each over the previous one's tail. */
  function piano(atSec: number[], lengthSec: number, noise = 0.001): Float32Array {
    const out = new Float32Array(Math.round(lengthSec * RATE));
    let seed = 1;
    for (let i = 0; i < out.length; i++) {
      seed = (seed * 16807) % 2147483647;
      out[i] = (seed / 2147483647 - 0.5) * 2 * noise;
    }
    for (const at of atSec) {
      const start = Math.round(at * RATE);
      for (let i = start; i < out.length; i++) {
        const t = (i - start) / RATE;
        out[i] = (out[i] ?? 0) + 0.3 * Math.exp(-t / 0.8) * Math.sin(2 * Math.PI * 65.4 * t);
      }
    }
    return out;
  }

  function run(samples: Float32Array, d = new OnsetDetector(RATE)): number[] {
    const found: number[] = [];
    for (let i = 0; i < samples.length; i += 128) {
      found.push(...d.push(samples.subarray(i, i + 128), i));
    }
    return found.map((f) => f / RATE);
  }

  it("finds each strike, including one over the previous note's tail", () => {
    const onsets = run(piano([0.5, 2.5, 4.0], 6));
    expect(onsets).toHaveLength(3);
    [0.5, 2.5, 4.0].forEach((at, i) => {
      expect(Math.abs((onsets[i] ?? 0) - at)).toBeLessThan(0.03);
    });
  });

  it("fires once for a double strike inside the refractory window", () => {
    const onsets = run(piano([0.5, 0.6], 2));
    expect(onsets).toHaveLength(1);
  });

  it("does not fire before it has enough history to compare against", () => {
    // A note struck at the very first sample has no quieter windows before it.
    expect(run(piano([0], 1))).toEqual([]);
  });

  it("ignores room noise below the minimum level", () => {
    expect(run(piano([], 3, 0.004))).toEqual([]);
  });
});
