import { req } from "./util";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ExpectedResponse, InputSource, NoteEvent } from "@clavis/core";
import {
  RHYTHM_TOLERANCE_MS,
  align,
  analyseRhythm,
  compareSequences,
  scoreAttempt,
  scoreExactPitch,
  scorePitchClass,
  scoreRhythm,
  scoreSequence,
} from "./index";

// Degree labels in C major: C=1 ... A=6, B=7, chromatic degrees flat/sharp.
const LABELS = ["1", "b2", "2", "b3", "3", "4", "#4", "5", "b6", "6", "b7", "7"];
const END = 1000;
const WINDOW = 5000;

const note = (pitch: number, onsetMs: number, source: InputSource = "midi"): NoteEvent => ({
  pitch,
  onsetMs,
  confidence: 1,
  source,
});

describe("pitch class", () => {
  const base = {
    targetMidi: 69,
    stimulusEndMs: END,
    responseWindowMs: WINDOW,
    degreeLabels: LABELS,
  };

  it("accepts the right pitch class in another octave", () => {
    const r = scorePitchClass({ ...base, notes: [note(57, END + 700)] });
    expect(r.outcome).toEqual({ correct: true, latencyMs: 700, retries: 0 });
    expect(r.errors).toEqual([]);
  });

  it("counts a wrong note before the right one as a retry with a confusion code", () => {
    const r = scorePitchClass({ ...base, notes: [note(67, END + 400), note(69, END + 1200)] });
    expect(r.outcome).toEqual({ correct: true, latencyMs: 1200, retries: 1 });
    expect(r.errors.map((e) => e.code)).toEqual(["degree.confusion.6-5"]);
  });

  it("times out with no response", () => {
    const r = scorePitchClass({ ...base, notes: [] });
    expect(r.outcome).toEqual({ correct: false, latencyMs: WINDOW, retries: 0 });
    expect(r.errors.map((e) => e.code)).toEqual(["response.timeout"]);
  });

  it("fails with only wrong notes and uses the last note as latency", () => {
    const r = scorePitchClass({ ...base, notes: [note(67, END + 300), note(71, END + 900)] });
    expect(r.outcome).toEqual({ correct: false, latencyMs: 900, retries: 2 });
    expect(r.errors.map((e) => e.code)).toEqual(["degree.confusion.6-5", "degree.confusion.6-7"]);
  });

  it("ignores notes before the stimulus end and after the window", () => {
    const r = scorePitchClass({
      ...base,
      notes: [note(69, END - 50), note(69, END + WINDOW + 1)],
    });
    expect(r.outcome.correct).toBe(false);
  });
});

describe("exact pitch", () => {
  const base = { targetMidi: 60, stimulusEndMs: END, responseWindowMs: WINDOW };

  it("matches the exact note", () => {
    const r = scoreExactPitch({ ...base, notes: [note(60, END + 500)] });
    expect(r.outcome).toEqual({ correct: true, latencyMs: 500, retries: 0 });
  });

  it("reports an octave error", () => {
    const r = scoreExactPitch({ ...base, notes: [note(72, END + 500), note(60, END + 1500)] });
    expect(r.outcome.retries).toBe(1);
    expect(r.errors[0]).toEqual({
      code: "pitch.octave",
      detail: { expected: 60, played: 72, octaves: 1 },
    });
  });

  it("reports a plain wrong note", () => {
    const r = scoreExactPitch({ ...base, notes: [note(62, END + 500)] });
    expect(r.outcome.correct).toBe(false);
    expect(r.errors[0]?.code).toBe("pitch.wrong");
  });
});

describe("sequence alignment", () => {
  it("returns distance 0 for identical input", () => {
    expect(align([1, 2, 3], [1, 2, 3])).toEqual({
      distance: 0,
      ops: [
        { op: "match", expectedIndex: 0, playedIndex: 0 },
        { op: "match", expectedIndex: 1, playedIndex: 1 },
        { op: "match", expectedIndex: 2, playedIndex: 2 },
      ],
    });
  });

  it("names positions for missing and extra", () => {
    expect(align([1, 2, 3], [1, 3]).ops).toContainEqual({ op: "missing", expectedIndex: 1 });
    expect(align([1, 3], [1, 2, 3]).ops).toContainEqual({ op: "extra", playedIndex: 1 });
  });
});

describe("sequence", () => {
  const expected = [60, 62, 64, 65];
  const run = (played: number[], octaveAgnostic = false) =>
    scoreSequence({
      midi: expected,
      octaveAgnostic,
      degreeLabels: LABELS,
      notes: played.map((p, i) => note(p, END + 500 + i * 400)),
      stimulusEndMs: END,
      responseWindowMs: WINDOW,
    });

  it("scores a perfect sequence", () => {
    const r = run([60, 62, 64, 65]);
    expect(r.outcome).toEqual({ correct: true, latencyMs: 500, retries: 0, partial: 1 });
    expect(r.errors).toEqual([]);
  });

  it("flags one wrong note with index and degrees", () => {
    const r = run([60, 62, 67, 65]);
    expect(r.outcome.correct).toBe(false);
    expect(r.outcome.partial).toBeCloseTo(0.75);
    expect(r.errors).toEqual([
      {
        code: "sequence.wrong-note",
        detail: { index: 2, expected: 64, played: 67, expectedDegree: "3", playedDegree: "5" },
      },
    ]);
  });

  it("flags a missing note", () => {
    const r = run([60, 64, 65]);
    expect(r.outcome.partial).toBeCloseTo(0.75);
    expect(r.errors.map((e) => e.code)).toEqual(["sequence.missing"]);
    expect(r.errors[0]?.detail).toMatchObject({ index: 1, expected: 62 });
  });

  it("flags an extra note", () => {
    const r = run([60, 62, 63, 64, 65]);
    expect(r.outcome.partial).toBeCloseTo(0.8);
    expect(r.errors).toEqual([{ code: "sequence.extra", detail: { index: 2, played: 63 } }]);
  });

  it("is octave agnostic only when asked", () => {
    const shifted = [60, 74, 64, 65];
    expect(run(shifted, true).outcome.correct).toBe(true);
    const strict = run(shifted, false);
    expect(strict.outcome.correct).toBe(false);
    expect(strict.errors[0]?.detail).toMatchObject({ octave: true });
  });

  it("times out with no notes", () => {
    const r = run([]);
    expect(r.outcome).toEqual({ correct: false, latencyMs: WINDOW, retries: 0, partial: 0 });
    expect(r.errors[0]?.code).toBe("response.timeout");
  });
});

describe("rhythm", () => {
  const beats = [0, 1, 2, 3, 4, 5, 6, 7];
  const BPM = 100;
  const beatMs = 60000 / BPM;
  const play = (times: number[], source: InputSource = "midi", onsetsBeats: number[] = beats) =>
    scoreRhythm({
      onsetsBeats,
      tempoBpm: BPM,
      notes: times.map((t) => note(60, t, source)),
      stimulusEndMs: END,
      responseWindowMs: 20000,
      source,
    });
  const at = (scale = 1, offset = 700) => beats.map((b) => END + offset + b * beatMs * scale);

  it("exports the tolerance table", () => {
    expect(RHYTHM_TOLERANCE_MS).toEqual({ midi: 60, tap: 80, mic: 100 });
  });

  it("scores a perfect performance", () => {
    const r = play(at());
    expect(r.outcome).toEqual({ correct: true, latencyMs: 700, retries: 0, partial: 1 });
    expect(r.errors).toEqual([]);
  });

  it("accepts a uniformly slower performance but reports tempo drift", () => {
    const r = play(at(1.2));
    expect(r.outcome.correct).toBe(true);
    expect(r.outcome.partial).toBe(1);
    expect(r.errors.map((e) => e.code)).toEqual(["rhythm.tempo-drift"]);
  });

  it("accepts a uniformly faster performance", () => {
    const r = play(at(0.85));
    expect(r.outcome.correct).toBe(true);
    expect(r.errors.map((e) => e.code)).toEqual(["rhythm.tempo-drift"]);
  });

  it("does not report drift for a slightly slower tempo", () => {
    const r = play(at(1.08));
    expect(r.outcome.correct).toBe(true);
    expect(r.errors).toEqual([]);
  });

  for (const source of ["midi", "tap", "mic"] as const) {
    const tol = RHYTHM_TOLERANCE_MS[source];
    it(`tolerates jitter within ${String(tol)} ms for ${source}`, () => {
      const jitter = [0.6, -0.6, 0.4, -0.5, 0.6, -0.4, 0.5, -0.6].map((j) => j * tol);
      const times = at().map((t, i) => t + req(jitter[i]));
      const r = play(times, source);
      expect(r.outcome.correct).toBe(true);
    });
  }

  it("flags a late note beyond tolerance", () => {
    const times = at();
    times[4] = req(times[4]) + 130;
    const r = play(times);
    expect(r.outcome.correct).toBe(false);
    expect(r.outcome.partial).toBeCloseTo(7 / 8);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.code).toBe("rhythm.late");
    const ms = (r.errors[0]?.detail as { ms: number; index: number }).ms;
    expect(ms).toBeGreaterThan(100);
    expect((r.errors[0]?.detail as { index: number }).index).toBe(4);
  });

  it("flags an early note", () => {
    const times = at();
    times[5] = req(times[5]) - 120;
    const r = play(times);
    expect(r.errors[0]?.code).toBe("rhythm.early");
  });

  it("flags a missing note and an extra note", () => {
    const missing = at().filter((_, i) => i !== 3);
    const rm = play(missing);
    expect(rm.outcome.correct).toBe(false);
    expect(rm.outcome.partial).toBeCloseTo(7 / 8);
    expect(rm.errors).toEqual([{ code: "rhythm.missed", detail: { index: 3, beat: 3 } }]);

    const withExtra = [...at(), END + 700 + 2.5 * beatMs].sort((a, b) => a - b);
    const re = play(withExtra);
    expect(re.outcome.correct).toBe(false);
    expect(re.outcome.partial).toBe(1);
    expect(re.errors.map((e) => e.code)).toEqual(["rhythm.extra"]);
  });

  it("handles a missing first note", () => {
    const eb = [0, 2, 3, 3.5, 5];
    const times = eb.map((b) => END + 500 + b * beatMs).slice(1);
    const r = play(times, "midi", eb);
    expect(r.errors.map((e) => e.code)).toEqual(["rhythm.missed"]);
    expect(r.errors[0]?.detail).toMatchObject({ index: 0 });
  });

  it("handles uneven rhythms", () => {
    const eb = [0, 1, 1.5, 2, 3.5];
    const r = play(
      eb.map((b) => END + 400 + b * beatMs * 1.1),
      "tap",
      eb,
    );
    expect(r.outcome.correct).toBe(true);
  });

  it("times out with no taps", () => {
    const r = play([]);
    expect(r.outcome).toMatchObject({ correct: false, latencyMs: 20000, partial: 0 });
    expect(r.errors[0]?.code).toBe("response.timeout");
  });

  it("analyseRhythm reports the fitted tempo", () => {
    const a = analyseRhythm(beats, BPM, at(1.2), 60);
    expect(a.fittedBpm).toBeCloseTo(BPM / 1.2, 3);
  });
});

describe("scoreAttempt", () => {
  const degree: ExpectedResponse = {
    play: { kind: "pitchClass", targetMidi: 69, degreeLabels: LABELS },
    responseWindowMs: WINDOW,
  };

  it("grades the played part only (R29)", () => {
    const right = scoreAttempt({
      expected: degree,
      notes: [note(57, END + 900)],
      stimulusEndMs: END,
      source: "midi",
    });
    expect(right.outcome).toEqual({ correct: true, latencyMs: 900, retries: 0 });
    expect(right.subScores).toEqual({ play: 1 });
    expect(right.errors).toEqual([]);
  });

  it("names a degree confusion without any sung wording", () => {
    const r = scoreAttempt({
      expected: degree,
      notes: [note(67, END + 600), note(69, END + 1500)],
      stimulusEndMs: END,
      source: "midi",
    });
    expect(r.outcome.retries).toBe(1);
    expect(r.errors[0]?.code).toBe("degree.confusion.6-5");
    expect(JSON.stringify(r.errors)).not.toMatch(/sing|sung/i);
  });

  it("ignores a legacy sung target on the expected response", () => {
    const legacy: ExpectedResponse = {
      ...degree,
      sing: { kind: "sungPitch", targetMidi: 60, toleranceCents: 50 },
    };
    const r = scoreAttempt({
      expected: legacy,
      notes: [note(57, END + 900)],
      stimulusEndMs: END,
      source: "midi",
    });
    expect(r.outcome.correct).toBe(true);
    expect(r.subScores).toEqual({ play: 1 });
  });

  it("scores Away-style play via taps (rhythm)", () => {
    const tempo = 90;
    const ms = 60000 / tempo;
    const expected: ExpectedResponse = {
      play: { kind: "rhythm", onsetsBeats: [0, 1, 2, 3], tempoBpm: tempo, beatsPerBar: 4 },
      responseWindowMs: 10000,
    };
    const taps = [0, 1, 2, 3].map((b) => note(60, END + 500 + b * ms * 1.05, "tap"));
    taps[2] = { ...req(taps[2]), onsetMs: req(taps[2]).onsetMs + 70 };
    const r = scoreAttempt({ expected, notes: taps, stimulusEndMs: END, source: "tap" });
    expect(r.outcome.correct).toBe(true);
    expect(r.subScores).toEqual({ play: 1 });
    const late = taps.map((n, i) => (i === 2 ? { ...n, onsetMs: n.onsetMs + 80 } : n));
    const r2 = scoreAttempt({ expected, notes: late, stimulusEndMs: END, source: "tap" });
    expect(r2.outcome.correct).toBe(false);
    expect(r2.errors[0]?.code).toBe("rhythm.late");
  });

  it("scores a play sequence", () => {
    const expected: ExpectedResponse = {
      play: { kind: "sequence", midi: [60, 62, 64], octaveAgnostic: false, degreeLabels: LABELS },
      responseWindowMs: WINDOW,
    };
    const r = scoreAttempt({
      expected,
      notes: [note(60, END + 300), note(62, END + 600), note(65, END + 900)],
      stimulusEndMs: END,
      source: "midi",
    });
    expect(r.outcome.correct).toBe(false);
    expect(r.subScores.play).toBeCloseTo(2 / 3);
  });

  it("throws when the item has no play target", () => {
    expect(() =>
      scoreAttempt({
        expected: {
          sing: { kind: "sungPitch", targetMidi: 69, toleranceCents: 50 },
          responseWindowMs: WINDOW,
        },
        notes: [],
        stimulusEndMs: END,
        source: "midi",
      }),
    ).toThrow(RangeError);
  });
});

describe("properties", () => {
  const midi = fc.integer({ min: 36, max: 96 });

  it("an expected sequence scores 1 against itself", () => {
    fc.assert(
      fc.property(fc.array(midi, { minLength: 1, maxLength: 16 }), fc.boolean(), (seq, oa) => {
        const r = scoreSequence({
          midi: seq,
          octaveAgnostic: oa,
          notes: seq.map((p, i) => note(p, END + 100 + i * 200)),
          stimulusEndMs: END,
          responseWindowMs: 60000,
        });
        expect(r.outcome.partial).toBe(1);
        expect(r.outcome.correct).toBe(true);
        expect(r.errors).toEqual([]);
      }),
    );
  });

  it("partial is always within [0, 1]", () => {
    fc.assert(
      fc.property(
        fc.array(midi, { minLength: 1, maxLength: 12 }),
        fc.array(midi, { maxLength: 12 }),
        fc.boolean(),
        (exp, got, oa) => {
          const r = compareSequences(exp, got, { octaveAgnostic: oa });
          expect(r.partial).toBeGreaterThanOrEqual(0);
          expect(r.partial).toBeLessThanOrEqual(1);
          expect(r.correct).toBe(r.distance === 0);
        },
      ),
    );
  });

  it("an expected rhythm scores 1 against itself at any tempo scale and offset", () => {
    const gaps = fc.array(fc.integer({ min: 2, max: 8 }), { minLength: 1, maxLength: 10 });
    fc.assert(
      fc.property(
        gaps,
        fc.double({ min: 0.9, max: 1.1, noNaN: true }),
        fc.integer({ min: 0, max: 2000 }),
        (g, scale, offset) => {
          const eighths = g.reduce<number[]>(
            (acc, x) => [...acc, (acc[acc.length - 1] ?? 0) + x],
            [0],
          );
          const onsetsBeats = eighths.map((e) => e / 2);
          const ms = 600;
          const r = scoreRhythm({
            onsetsBeats,
            tempoBpm: 100,
            notes: onsetsBeats.map((b) => note(60, END + offset + b * ms * scale)),
            stimulusEndMs: END,
            responseWindowMs: 120000,
            source: "midi",
          });
          expect(r.outcome.partial).toBe(1);
          expect(r.outcome.correct).toBe(true);
        },
      ),
    );
  });

  it("rhythm partial stays in [0, 1] for arbitrary onsets", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 8000 }), { maxLength: 14 }),
        fc.constantFrom<InputSource>("midi", "tap", "mic"),
        (times, source) => {
          const r = scoreRhythm({
            onsetsBeats: [0, 1, 2, 3, 4],
            tempoBpm: 100,
            notes: times.map((t) => note(60, END + t, source)),
            stimulusEndMs: END,
            responseWindowMs: 10000,
            source,
          });
          expect(r.outcome.partial).toBeGreaterThanOrEqual(0);
          expect(r.outcome.partial).toBeLessThanOrEqual(1);
        },
      ),
    );
  });
});
