import { TAKES, takeTruth, type Take } from "@clavis/audio";
import { describe, expect, it } from "vitest";
import { cueAt, scoreTake } from "./record-take";

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
