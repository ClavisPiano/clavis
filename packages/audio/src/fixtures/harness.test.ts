import { describe, expect, it } from "vitest";
import {
  compareToBaseline,
  formatReport,
  matchNotes,
  percentile,
  runAccuracy,
  scoreDetections,
} from "./accuracy";
import { parseManifest, type FixtureEntry } from "./manifest";
import { renderNotes } from "../pitch/synth";
import { writeWav } from "./wav";

const truth = (midi: number, onsetMs: number) => ({ midi, onsetMs });
const det = (pitch: number, onsetMs: number) => ({ pitch, onsetMs });

describe("matchNotes", () => {
  it("pairs greedily within the tolerance and prefers the same pitch", () => {
    const m = matchNotes(
      [truth(60, 0), truth(62, 500)],
      [det(61, 20), det(60, 60), det(62, 480), det(70, 2000)],
      100,
    );
    expect(m.pairs.map((p) => [p.truth.midi, p.detectedPitch, p.onsetErrorMs])).toEqual([
      [60, 60, 60],
      [62, 62, 20],
    ]);
    expect(m.truthCount).toBe(2);
    expect(m.detectedCount).toBe(4);
  });

  it("uses each detection once", () => {
    const m = matchNotes([truth(60, 0), truth(60, 50)], [det(60, 25)], 100);
    expect(m.pairs).toHaveLength(1);
  });
});

describe("percentile", () => {
  it("uses nearest rank", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(percentile([5], 0.9)).toBe(5);
  });
});

const entry = (id: string, kind: FixtureEntry["kind"], midis: number[]): FixtureEntry => ({
  id,
  file: `${id}.wav`,
  kind,
  instrument: "voice",
  device: "test",
  notes: midis.map((midi, i) => ({ midi, onsetMs: i * 500 })),
});

describe("scoreDetections", () => {
  const manifest = [entry("a", "sung-degree", [60, 62, 64, 65]), entry("b", "piano-single", [48])];
  const detected = new Map([
    // 60 exact, 62 an octave low, 64 a semitone off, 65 missed, plus one false positive.
    ["a", [det(60, 10), det(50, 520), det(65, 1020), det(72, 1800)]],
    ["b", [det(48, 30)]],
  ]);
  const r = scoreDetections(manifest, detected);

  it("computes per entry metrics", () => {
    const a = r.entries.a;
    expect(a?.truth).toBe(4);
    expect(a?.detected).toBe(4);
    expect(a?.matched).toBe(3);
    expect(a?.precision).toBeCloseTo(1 / 4);
    expect(a?.recall).toBeCloseTo(1 / 4);
    expect(a?.pitchExact).toBeCloseTo(1 / 3);
    expect(a?.pitchClass).toBeCloseTo(2 / 3);
    expect(a?.octaveErrorRate).toBeCloseTo(1 / 3);
    expect(a?.onsetMedianMs).toBe(20);
  });

  it("counts octave errors", () => {
    const o = scoreDetections(
      [entry("o", "sung-degree", [60, 64])],
      new Map([["o", [det(48, 0), det(64, 500)]]]),
    );
    expect(o.entries.o?.octaveErrorRate).toBeCloseTo(0.5);
    expect(o.entries.o?.pitchClass).toBe(1);
    expect(o.entries.o?.pitchExact).toBe(0.5);
  });

  it("pools counts per kind and overall", () => {
    expect(r.byKind["piano-single"]?.f1).toBe(1);
    expect(r.byKind["sung-degree"]?.truth).toBe(4);
    expect(r.overall.truth).toBe(5);
    expect(r.overall.matched).toBe(4);
    expect(r.overall.f1).toBeCloseTo((2 * (2 / 5) * (2 / 5)) / (4 / 5));
  });

  it("reports null for empty denominators", () => {
    const e = scoreDetections([entry("e", "two-hand", [60])], new Map());
    expect(e.entries.e?.precision).toBeNull();
    expect(e.entries.e?.recall).toBe(0);
    expect(e.entries.e?.onsetMedianMs).toBeNull();
  });
});

describe("compareToBaseline", () => {
  const manifest = [entry("a", "sung-degree", [60, 62, 64, 65])];
  const good = scoreDetections(
    manifest,
    new Map([["a", [det(60, 0), det(62, 500), det(64, 1000), det(65, 1500)]]]),
  );

  it("passes on identical and small changes", () => {
    expect(compareToBaseline(good, good)).toEqual([]);
    const slower = scoreDetections(
      manifest,
      new Map([["a", [det(60, 8), det(62, 508), det(64, 1008), det(65, 1508)]]]),
    );
    expect(compareToBaseline(slower, good)).toEqual([]);
  });

  it("flags F1 and onset regressions", () => {
    const worse = scoreDetections(
      manifest,
      new Map([["a", [det(60, 30), det(62, 530), det(64, 1030), det(66, 1500)]]]),
    );
    const problems = compareToBaseline(worse, good);
    expect(problems.some((p) => p.includes("F1"))).toBe(true);
    expect(problems.some((p) => p.includes("median onset"))).toBe(true);
  });

  it("flags entries missing from the baseline or the manifest", () => {
    const empty = { overall: good.overall, byKind: good.byKind, entries: {} };
    expect(compareToBaseline(good, empty).some((p) => p.includes("not in baseline"))).toBe(true);
    expect(compareToBaseline(empty, good).some((p) => p.includes("no longer"))).toBe(true);
  });
});

describe("runAccuracy and manifest", () => {
  const SR = 22050;
  const audio = renderNotes(
    [60, 64, 67].map((midi, i) => ({
      midi,
      startSec: 0.2 + i * 0.6,
      durSec: 0.4,
      timbre: "piano" as const,
    })),
    SR,
    2.2,
  );
  const manifest = parseManifest([
    {
      id: "tiny",
      file: "tiny.wav",
      kind: "piano-sequence",
      instrument: "acoustic-piano",
      device: "synthetic",
      notes: [60, 64, 67].map((midi, i) => ({
        midi,
        onsetMs: 200 + i * 600,
        offsetMs: 600 + i * 600,
      })),
      expectedRange: { low: 55, high: 72 },
    },
  ]);

  it("runs an in-memory corpus end to end", async () => {
    const paths: string[] = [];
    const r = await runAccuracy(
      manifest,
      (p) => {
        paths.push(p);
        return Promise.resolve(writeWav(audio, SR));
      },
      { baseDir: "/fx/" },
    );
    expect(paths).toEqual(["/fx/tiny.wav"]);
    expect(r.overall.f1).toBe(1);
    expect(r.overall.onsetMedianMs).toBeLessThan(60);
    expect(formatReport(manifest, r)).toContain("| tiny | piano-sequence |");
  });

  it("rejects bad manifests", () => {
    const base = {
      id: "x",
      file: "x.wav",
      kind: "voice",
      instrument: "voice",
      device: "d",
      notes: [{ midi: 60, onsetMs: 0 }],
    };
    expect(() => parseManifest([base])).toThrow();
    expect(() => parseManifest([{ ...base, kind: "sung-degree", file: "../x.wav" }])).toThrow();
    expect(() =>
      parseManifest([
        { ...base, kind: "sung-degree" },
        { ...base, kind: "sung-degree" },
      ]),
    ).toThrow(/unique/);
    expect(() => parseManifest([{ ...base, kind: "sung-degree", notes: [] }])).toThrow();
  });
});
