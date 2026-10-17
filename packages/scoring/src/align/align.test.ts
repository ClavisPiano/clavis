import { req } from "../util";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ScoreSpec } from "@clavis/core";
import {
  TOLERANCES,
  alignPerformance,
  expectedFromScore,
  type AlignResult,
  type ExpectedNote,
  type NoteClass,
  type PerformedNote,
} from "../index";
import type { InputSource } from "@clavis/core";

const BPM = 100;
const BEAT_MS = 60000 / BPM;

/** A phrase with varied rhythm, repeated pitches and one chord (beat 6). */
const PHRASE: ExpectedNote[] = [
  { id: "a", midi: 60, onsetBeats: 0, durationBeats: 1 },
  { id: "b", midi: 62, onsetBeats: 1, durationBeats: 1 },
  { id: "c", midi: 64, onsetBeats: 2, durationBeats: 0.5 },
  { id: "d", midi: 64, onsetBeats: 2.5, durationBeats: 0.5 },
  { id: "e", midi: 65, onsetBeats: 3, durationBeats: 1 },
  { id: "f", midi: 67, onsetBeats: 4, durationBeats: 2 },
  { id: "g1", midi: 60, onsetBeats: 6, durationBeats: 1 },
  { id: "g2", midi: 64, onsetBeats: 6, durationBeats: 1 },
  { id: "g3", midi: 67, onsetBeats: 6, durationBeats: 1 },
  { id: "h", midi: 72, onsetBeats: 7, durationBeats: 1 },
  { id: "i", midi: 71, onsetBeats: 8, durationBeats: 1 },
  { id: "j", midi: 69, onsetBeats: 9, durationBeats: 2 },
];

/** Render expected notes to performed notes with a time warp (beats to ms). */
function render(
  expected: readonly ExpectedNote[],
  warp: (beats: number) => number,
  tweak: (n: ExpectedNote, ms: number, i: number) => number = (_n, ms) => ms,
): PerformedNote[] {
  return expected.map((n, i) => ({ midi: n.midi, onsetMs: tweak(n, warp(n.onsetBeats), i) }));
}

const linear =
  (beatMs: number, start: number) =>
  (b: number): number =>
    start + b * beatMs;

const classes = (r: AlignResult): NoteClass[] => r.notes.map((n) => n.cls);
const align = (performed: PerformedNote[], source: InputSource = "midi", countIn?: number) =>
  alignPerformance({
    expected: PHRASE,
    tempoBpm: BPM,
    performed,
    options: { source },
    ...(countIn === undefined ? {} : { countInRefMs: countIn }),
  });
const ALL_CORRECT: NoteClass[] = PHRASE.map(() => "correct");

describe("alignPerformance table", () => {
  const exact = render(PHRASE, linear(BEAT_MS, 1500));
  const lateIdx = 5; // note "f"

  const cases: {
    name: string;
    performed: PerformedNote[];
    countIn?: number;
    check: (r: AlignResult) => void;
  }[] = [
    {
      name: "exact match",
      performed: exact,
      check: (r) => {
        expect(classes(r)).toEqual(ALL_CORRECT);
        expect(r.extras).toEqual([]);
        expect(r.summary.overall).toBeCloseTo(1, 9);
        expect(r.tempoRatio).toBeCloseTo(1, 6);
      },
    },
    {
      name: "exact match with a count-in reference",
      performed: exact,
      countIn: 1500,
      check: (r) => {
        expect(classes(r)).toEqual(ALL_CORRECT);
      },
    },
    {
      name: "a missed note",
      performed: exact.filter((_, i) => i !== 3),
      check: (r) => {
        const want = [...ALL_CORRECT];
        want[3] = "missed";
        expect(classes(r)).toEqual(want);
        expect(r.notes[3]?.deviationMs).toBeUndefined();
        expect(r.summary.completeness).toBeCloseTo(11 / 12, 9);
        expect(r.extras).toEqual([]);
      },
    },
    {
      name: "an extra note",
      performed: [...exact, { midi: 70, onsetMs: 1500 + 4.5 * BEAT_MS }].sort(
        (a, b) => a.onsetMs - b.onsetMs,
      ),
      check: (r) => {
        expect(classes(r)).toEqual(ALL_CORRECT);
        expect(r.extras.map((e) => e.midi)).toEqual([70]);
        expect(r.summary.pitchAccuracy).toBeCloseTo(12 / 13, 9);
      },
    },
    {
      name: "a wrong pitch",
      performed: exact.map((n, i) => (i === 4 ? { ...n, midi: 66 } : n)),
      check: (r) => {
        const want = [...ALL_CORRECT];
        want[4] = "wrongPitch";
        expect(classes(r)).toEqual(want);
        expect(r.notes[4]?.playedMidi).toBe(66);
        expect(r.extras).toEqual([]);
        expect(r.summary.completeness).toBe(1);
      },
    },
    {
      name: "a uniformly 20% slower take",
      performed: render(PHRASE, linear(BEAT_MS * 1.2, 900)),
      check: (r) => {
        expect(classes(r)).toEqual(ALL_CORRECT);
        expect(r.tempoRatio).toBeCloseTo(1.2, 2);
        expect(r.summary.timingAccuracy).toBe(1);
      },
    },
    {
      name: "a uniformly 20% slower take with the count-in reference at nominal pace",
      performed: render(PHRASE, linear(BEAT_MS * 1.2, 1500)),
      countIn: 1500,
      check: (r) => {
        expect(classes(r)).toEqual(ALL_CORRECT);
      },
    },
    {
      name: "a gradual drift (tempo slows then recovers)",
      // Beat duration eases smoothly from 1.35x to about 1.04x of nominal.
      performed: render(PHRASE, (b) => 1200 + BEAT_MS * (b + 0.35 * (b - 0.04 * b * b))),
      check: (r) => {
        expect(classes(r)).toEqual(ALL_CORRECT);
      },
    },
    {
      name: "one genuinely late note in a steady take",
      performed: render(PHRASE, linear(BEAT_MS, 1500), (_n, ms, i) =>
        i === lateIdx ? ms + 180 : ms,
      ),
      check: (r) => {
        const want = [...ALL_CORRECT];
        want[lateIdx] = "late";
        expect(classes(r)).toEqual(want);
        expect(r.notes[lateIdx]?.deviationMs).toBeCloseTo(180, 0);
      },
    },
    {
      name: "one early note in a slow take",
      performed: render(PHRASE, linear(BEAT_MS * 1.15, 1500), (_n, ms, i) =>
        i === 10 ? ms - 200 : ms,
      ),
      check: (r) => {
        const want = [...ALL_CORRECT];
        want[10] = "early";
        expect(classes(r)).toEqual(want);
      },
    },
    {
      name: "a rolled chord (40 ms spread) is correct",
      performed: render(PHRASE, linear(BEAT_MS, 1500), (n, ms) =>
        n.id === "g2" ? ms + 20 : n.id === "g3" ? ms + 40 : ms,
      ),
      check: (r) => {
        expect(classes(r)).toEqual(ALL_CORRECT);
        expect(r.extras).toEqual([]);
      },
    },
    {
      name: "a chord with one note missing",
      performed: exact.filter((_, i) => i !== 7),
      check: (r) => {
        const want = [...ALL_CORRECT];
        want[7] = "missed";
        expect(classes(r)).toEqual(want);
      },
    },
    {
      name: "a short note when offsets are known",
      performed: exact.map((n, i) => {
        const e = req(PHRASE[i]);
        const held = i === 5 ? 0.2 : 0.9;
        return { ...n, offsetMs: n.onsetMs + held * e.durationBeats * BEAT_MS };
      }),
      check: (r) => {
        const want = [...ALL_CORRECT];
        want[5] = "short";
        expect(classes(r)).toEqual(want);
      },
    },
  ];

  it.each(cases)("$name", ({ performed, countIn, check }) => {
    check(align(performed, "midi", countIn));
  });

  it("empty performance misses everything", () => {
    const r = align([]);
    expect(classes(r)).toEqual(PHRASE.map(() => "missed"));
    expect(r.summary.overall).toBe(0);
  });

  it("empty expectation makes every performed note an extra", () => {
    const r = alignPerformance({
      expected: [],
      tempoBpm: 90,
      performed: [{ midi: 60, onsetMs: 10 }],
      options: { source: "midi" },
    });
    expect(r.notes).toEqual([]);
    expect(r.extras).toHaveLength(1);
  });

  it("rejects a non-positive tempo", () => {
    expect(() => alignPerformance({ ...base(), tempoBpm: 0 })).toThrow(RangeError);
  });
});

function base() {
  return { expected: PHRASE, tempoBpm: BPM, performed: [], options: { source: "midi" as const } };
}

describe("tolerances by source", () => {
  it("mic is looser than tap, tap looser than midi", () => {
    expect(TOLERANCES.midi.onTimeMs).toBeLessThan(TOLERANCES.tap.onTimeMs);
    expect(TOLERANCES.tap.onTimeMs).toBeLessThan(TOLERANCES.mic.onTimeMs);
  });

  it("the same 90 ms deviation is late for midi but correct for mic", () => {
    const performed = render(PHRASE, linear(BEAT_MS, 1500), (_n, ms, i) =>
      i === 5 ? ms + 90 : ms,
    );
    expect(align(performed, "midi").notes[5]?.cls).toBe("late");
    expect(align(performed, "mic").notes[5]?.cls).toBe("correct");
  });

  it("a 100 ms roll is one chord for mic but not for midi", () => {
    const roll = render(PHRASE, linear(BEAT_MS, 1500), (n, ms) =>
      n.id === "g2" ? ms + 50 : n.id === "g3" ? ms + 100 : ms,
    );
    expect(classes(align(roll, "mic"))).toEqual(ALL_CORRECT);
    expect(classes(align(roll, "midi"))).not.toEqual(ALL_CORRECT);
  });
});

describe("expectedFromScore", () => {
  const spelled = (step: "C" | "D" | "E" | "G", octave = 4) => ({ step, alter: 0, octave });
  const score: ScoreSpec = {
    staves: [
      {
        clef: "treble",
        lines: 5,
        measures: [
          [
            // dotted quarter C4, eighth D4, then a half E4 tied across the bar line
            {
              kind: "note",
              id: "n1",
              pitches: [spelled("C")],
              duration: { value: 4, dots: 1 },
            },
            { kind: "note", id: "n2", pitches: [spelled("D")], duration: { value: 8, dots: 0 } },
            {
              kind: "note",
              id: "n3",
              pitches: [spelled("E")],
              duration: { value: 2, dots: 0, tie: "start" },
            },
          ],
          [
            {
              kind: "note",
              id: "n4",
              pitches: [spelled("E")],
              duration: { value: 4, dots: 0, tie: "stop" },
            },
            { kind: "rest", duration: { value: 4, dots: 0 } },
            {
              kind: "note",
              id: "n5",
              pitches: [spelled("C"), spelled("G")],
              duration: { value: 4, dots: 0 },
            },
          ],
        ],
      },
    ],
    key: null,
    meter: { beats: 4, beatValue: 4 },
  };

  it("handles a dotted note, a tie, a rest and a chord", () => {
    expect(expectedFromScore(score)).toEqual([
      { id: "n1", midi: 60, onsetBeats: 0, durationBeats: 1.5 },
      { id: "n2", midi: 62, onsetBeats: 1.5, durationBeats: 0.5 },
      { id: "n3", midi: 64, onsetBeats: 2, durationBeats: 3 },
      { id: "n5.0", midi: 60, onsetBeats: 6, durationBeats: 1 },
      { id: "n5.1", midi: 67, onsetBeats: 6, durationBeats: 1 },
    ]);
  });

  it("counts beats in the meter's beat value", () => {
    const eighths: ScoreSpec = {
      ...score,
      meter: { beats: 6, beatValue: 8 },
      staves: [
        {
          clef: "treble",
          lines: 5,
          measures: [
            [
              { kind: "note", id: "n1", pitches: [spelled("C")], duration: { value: 8, dots: 0 } },
              { kind: "note", id: "n2", pitches: [spelled("D")], duration: { value: 4, dots: 0 } },
            ],
          ],
        },
      ],
    };
    expect(expectedFromScore(eighths).map((n) => [n.onsetBeats, n.durationBeats])).toEqual([
      [0, 1],
      [1, 2],
    ]);
  });
});

describe("alignPerformance properties", () => {
  const expectedArb = fc
    .array(
      fc.record({
        gap: fc.constantFrom(0.5, 1, 1.5, 2),
        chord: fc.array(fc.integer({ min: 48, max: 84 }), { minLength: 1, maxLength: 3 }),
      }),
      { minLength: 1, maxLength: 24 },
    )
    .map((steps) => {
      const out: ExpectedNote[] = [];
      let t = 0;
      steps.forEach((s, i) => {
        for (const [k, midi] of [...new Set(s.chord)].entries())
          out.push({ id: `e${String(i)}.${String(k)}`, midi, onsetBeats: t, durationBeats: s.gap });
        t += s.gap;
      });
      return out;
    });

  const source = fc.constantFrom<InputSource>("midi", "tap", "mic");

  it("an identical performance at any tempo and start offset scores 1", () => {
    fc.assert(
      fc.property(
        expectedArb,
        fc.integer({ min: 40, max: 200 }),
        fc.integer({ min: 0, max: 20000 }),
        source,
        (expected, bpm, start, src) => {
          const performed = render(expected, linear(60000 / bpm, start));
          const r = alignPerformance({
            expected,
            tempoBpm: bpm,
            performed,
            options: { source: src },
          });
          expect(r.notes.every((n) => n.cls === "correct")).toBe(true);
          expect(r.extras).toEqual([]);
          expect(r.summary.overall).toBeCloseTo(1, 9);
        },
      ),
    );
  });

  it("a uniformly scaled performance is all correct", () => {
    fc.assert(
      fc.property(
        expectedArb,
        fc.integer({ min: 60, max: 160 }),
        fc.double({ min: 0.7, max: 1.4, noNaN: true }),
        (expected, bpm, ratio) => {
          const performed = render(expected, linear((60000 / bpm) * ratio, 3000));
          const r = alignPerformance({
            expected,
            tempoBpm: bpm,
            performed,
            options: { source: "midi" },
          });
          expect(r.notes.every((n) => n.cls === "correct")).toBe(true);
        },
      ),
    );
  });

  it("an extra performed note never lowers the number of correct notes", () => {
    fc.assert(
      fc.property(
        expectedArb,
        fc.integer({ min: 40, max: 200 }),
        fc.integer({ min: 0, max: 127 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (expected, bpm, midi, where) => {
          const performed = render(expected, linear(60000 / bpm, 1000));
          const last = performed[performed.length - 1]?.onsetMs ?? 1000;
          const extra: PerformedNote = { midi, onsetMs: 1000 + where * (last - 1000 + 500) };
          const run = (p: PerformedNote[]): number =>
            alignPerformance({
              expected,
              tempoBpm: bpm,
              performed: p,
              options: { source: "midi" },
            }).notes.filter((n) => n.cls === "correct").length;
          expect(run([...performed, extra])).toBeGreaterThanOrEqual(run(performed));
        },
      ),
    );
  });

  it("returns exactly one entry per expected note, in order, for any performance", () => {
    fc.assert(
      fc.property(
        expectedArb,
        fc.array(
          fc.record({
            midi: fc.integer({ min: 40, max: 90 }),
            onsetMs: fc.integer({ min: 0, max: 30000 }),
          }),
          { maxLength: 40 },
        ),
        source,
        (expected, performed, src) => {
          const r = alignPerformance({
            expected,
            tempoBpm: 90,
            performed,
            options: { source: src },
          });
          expect(r.notes.map((n) => n.id)).toEqual(expected.map((n) => n.id));
          const matched = r.notes.filter((n) => n.performedIndex !== undefined).length;
          expect(matched + r.extras.length).toBe(performed.length);
          expect(r.summary.overall).toBeGreaterThanOrEqual(0);
          expect(r.summary.overall).toBeLessThanOrEqual(1);
        },
      ),
    );
  });
});
