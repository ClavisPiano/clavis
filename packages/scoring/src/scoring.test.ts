import { req } from "./util";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ExpectedResponse, InputSource, NoteEvent, PitchFrame } from "@clavis/core";
import {
  RHYTHM_TOLERANCE_MS,
  align,
  analyseRhythm,
  combineParts,
  compareSequences,
  findStableSegments,
  scoreAttempt,
  scoreExactPitch,
  scorePitchClass,
  scoreRhythm,
  scoreSequence,
  scoreSungPitch,
  scoreSungSequence,
  segmentSungNotes,
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

const hz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

/** Frames every 10 ms at a fractional midi pitch. */
function frames(
  midi: number,
  fromMs: number,
  toMs: number,
  opts: { confidence?: number; hz?: number | null } = {},
): PitchFrame[] {
  const out: PitchFrame[] = [];
  for (let t = fromMs; t <= toMs; t += 10) {
    out.push({
      hz: opts.hz === undefined ? hz(midi) : opts.hz,
      confidence: opts.confidence ?? 0.95,
      atMs: t,
    });
  }
  return out;
}

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

describe("sung pitch", () => {
  const base = {
    targetMidi: 69,
    toleranceCents: 50,
    stimulusEndMs: END,
    responseWindowMs: WINDOW,
    degreeLabels: LABELS,
  };

  it("accepts an in-tune pitch in any octave", () => {
    const r = scoreSungPitch({ ...base, frames: frames(57, END + 400, END + 900) });
    expect(r.outcome).toEqual({ correct: true, latencyMs: 400, retries: 0 });
    expect(r.errors).toEqual([]);
  });

  it("accepts 30 cents flat", () => {
    const r = scoreSungPitch({ ...base, frames: frames(69 - 0.3, END + 300, END + 800) });
    expect(r.outcome.correct).toBe(true);
  });

  it("rejects 70 cents sharp with sing.sharp", () => {
    const r = scoreSungPitch({ ...base, frames: frames(69.7, END + 300, END + 800) });
    expect(r.outcome.correct).toBe(false);
    expect(r.errors).toEqual([{ code: "sing.sharp", detail: { cents: 70 } }]);
  });

  it("reports sing.flat with cents", () => {
    const r = scoreSungPitch({ ...base, frames: frames(68.4, END + 300, END + 800) });
    expect(r.errors).toEqual([{ code: "sing.flat", detail: { cents: -60 } }]);
  });

  it("reports sing.none for low-confidence frames", () => {
    const r = scoreSungPitch({
      ...base,
      frames: frames(69, END + 300, END + 1200, { confidence: 0.5 }),
    });
    expect(r.outcome).toEqual({ correct: false, latencyMs: WINDOW, retries: 0 });
    expect(r.errors.map((e) => e.code)).toEqual(["sing.none"]);
  });

  it("reports sing.none for unvoiced frames and for too-short segments", () => {
    expect(
      scoreSungPitch({ ...base, frames: frames(69, END + 300, END + 1200, { hz: null }) }).errors[0]
        ?.code,
    ).toBe("sing.none");
    expect(
      scoreSungPitch({ ...base, frames: frames(69, END + 300, END + 450) }).errors[0]?.code,
    ).toBe("sing.none");
  });

  it("reports sing.none for an unstable (gliding) voice", () => {
    const glide: PitchFrame[] = [];
    for (let t = 0; t <= 600; t += 10) {
      glide.push({ hz: hz(60 + t / 50), confidence: 0.95, atMs: END + 100 + t });
    }
    expect(scoreSungPitch({ ...base, frames: glide }).errors[0]?.code).toBe("sing.none");
  });

  it("names a degree confusion when a 5th is sung for the 6th", () => {
    const r = scoreSungPitch({ ...base, frames: frames(67, END + 300, END + 800) });
    expect(r.outcome.correct).toBe(false);
    expect(r.errors[0]?.code).toBe("degree.confusion.6-5");
  });

  it("falls back to pitch.wrong without labels", () => {
    const r = scoreSungPitch({
      ...base,
      degreeLabels: undefined,
      frames: frames(67, END + 300, END + 800),
    });
    expect(r.errors[0]?.code).toBe("pitch.wrong");
  });

  it("ignores frames before the stimulus end and skips a short blip to find a stable segment", () => {
    const f = [
      ...frames(60, END - 500, END - 100),
      ...frames(75, END + 100, END + 150),
      ...frames(69, END + 500, END + 900),
    ];
    const r = scoreSungPitch({ ...base, frames: f });
    expect(r.outcome).toEqual({ correct: true, latencyMs: 500, retries: 0 });
  });

  it("finds stable segments with configurable confidence", () => {
    const f = frames(69, 0, 400, { confidence: 0.7 });
    expect(findStableSegments(f)).toHaveLength(0);
    expect(findStableSegments(f, { minConfidence: 0.6 })).toHaveLength(1);
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

describe("sung sequence", () => {
  const sing = (midis: number[], gapMs = 50) => {
    const f: PitchFrame[] = [];
    let t = END + 300;
    for (const m of midis) {
      f.push(...frames(m, t, t + 300));
      t += 300 + gapMs;
    }
    return f;
  };
  const base = { midi: [60, 62, 64], stimulusEndMs: END, responseWindowMs: WINDOW };

  it("splits notes by gap and by pitch change", () => {
    expect(segmentSungNotes(sing([60, 62, 64]))).toHaveLength(3);
    expect(segmentSungNotes(sing([60, 62, 64], 0))).toHaveLength(3);
  });

  it("scores a perfect sung sequence in another octave", () => {
    const r = scoreSungSequence({ ...base, frames: sing([48, 50, 52]) });
    expect(r.outcome).toEqual({ correct: true, latencyMs: 300, retries: 0, partial: 1 });
  });

  it("flags a wrong sung note and a missing one", () => {
    const wrong = scoreSungSequence({ ...base, frames: sing([60, 63, 64]) });
    expect(wrong.errors.map((e) => e.code)).toEqual(["sequence.wrong-note"]);
    const missing = scoreSungSequence({ ...base, frames: sing([60, 64]) });
    expect(missing.errors.map((e) => e.code)).toEqual(["sequence.missing"]);
  });

  it("reports sing.none when silent", () => {
    const r = scoreSungSequence({ ...base, frames: [] });
    expect(r.errors[0]?.code).toBe("sing.none");
    expect(r.outcome.partial).toBe(0);
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
  const degreeSing: ExpectedResponse = {
    sing: { kind: "sungPitch", targetMidi: 69, toleranceCents: 50 },
    play: { kind: "pitchClass", targetMidi: 69, degreeLabels: LABELS },
    responseWindowMs: WINDOW,
  };

  it("is incorrect when the sung part is wrong, even with the right played note (R12)", () => {
    const r = scoreAttempt({
      expected: degreeSing,
      notes: [note(57, END + 900)],
      frames: frames(69.7, END + 300, END + 800),
      stimulusEndMs: END,
      source: "midi",
    });
    expect(r.outcome).toEqual({ correct: false, latencyMs: 900, retries: 0 });
    expect(r.subScores).toEqual({ sing: 0, play: 1 });
    expect(r.errors).toEqual([{ code: "sing.sharp", detail: { cents: 70, part: "sing" } }]);
  });

  it("is correct when both parts are right, with latency from the played part", () => {
    const r = scoreAttempt({
      expected: degreeSing,
      notes: [note(57, END + 900)],
      frames: frames(69, END + 300, END + 800),
      stimulusEndMs: END,
      source: "midi",
    });
    expect(r.outcome).toEqual({ correct: true, latencyMs: 900, retries: 0 });
    expect(r.errors).toEqual([]);
  });

  it("names sung confusion with labels from the play target", () => {
    const r = scoreAttempt({
      expected: degreeSing,
      notes: [note(67, END + 600), note(69, END + 1500)],
      frames: frames(67, END + 300, END + 800),
      stimulusEndMs: END,
      source: "midi",
    });
    expect(r.outcome.retries).toBe(1);
    // Play and sing both report the same confusion with different detail; play comes first.
    expect(r.errors[0]?.code).toBe("degree.confusion.6-5");
  });

  it("uses sing for the outcome when only a sung part exists (Away)", () => {
    const r = scoreAttempt({
      expected: { sing: degreeSing.sing, responseWindowMs: WINDOW },
      notes: [],
      frames: frames(69, END + 400, END + 900),
      stimulusEndMs: END,
      source: "mic",
    });
    expect(r.outcome).toEqual({ correct: true, latencyMs: 400, retries: 0 });
    expect(r.subScores).toEqual({ sing: 1 });
  });

  it("names a sung confusion from the sing target's own labels (Away, sing only)", () => {
    const r = scoreAttempt({
      expected: {
        sing: { kind: "sungPitch", targetMidi: 69, toleranceCents: 50, degreeLabels: LABELS },
        responseWindowMs: WINDOW,
      },
      notes: [],
      frames: frames(67, END + 400, END + 900),
      stimulusEndMs: END,
      source: "mic",
    });
    expect(r.outcome.correct).toBe(false);
    expect(r.errors[0]?.code).toBe("degree.confusion.6-5");
  });

  it("honours part to score only singing", () => {
    const r = scoreAttempt({
      expected: degreeSing,
      notes: [],
      frames: frames(69, END + 400, END + 900),
      stimulusEndMs: END,
      source: "mic",
      part: "sing",
    });
    expect(r.subScores).toEqual({ sing: 1 });
    expect(r.outcome.correct).toBe(true);
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

  it("throws when the requested part is not expected", () => {
    expect(() =>
      scoreAttempt({
        expected: { sing: degreeSing.sing, responseWindowMs: WINDOW },
        notes: [],
        stimulusEndMs: END,
        source: "midi",
        part: "play",
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

describe("combineParts (R12)", () => {
  const part = (
    correct: boolean,
    latencyMs: number,
    errors: { code: string }[] = [],
    partial?: number,
  ) => ({
    outcome: { correct, latencyMs, retries: 0, ...(partial === undefined ? {} : { partial }) },
    errors,
  });

  it.each([
    ["both right", true, true, true],
    ["sung wrong", false, true, false],
    ["played wrong", true, false, false],
    ["both wrong", false, false, false],
  ] as const)("%s -> correct %s", (_name, sing, play, correct) => {
    const r = combineParts({ sing: part(sing, 300), play: part(play, 900) });
    expect(r.outcome).toEqual({ correct, latencyMs: 900, retries: 0 });
  });

  it("averages sub-scores into partial when a part has partial credit", () => {
    const r = combineParts({ sing: part(false, 300, [], 0.5), play: part(true, 900) });
    expect(r.outcome.partial).toBe(0.75);
  });

  it("uses a single part as is", () => {
    expect(combineParts({ sing: part(true, 400) }).outcome).toEqual({
      correct: true,
      latencyMs: 400,
      retries: 0,
    });
  });

  it("tags errors with their part, played first", () => {
    const r = combineParts({
      sing: part(false, 300, [{ code: "degree.confusion.1-5" }]),
      play: part(false, 900, [{ code: "degree.confusion.1-5" }]),
    });
    expect(r.errors).toEqual([
      { code: "degree.confusion.1-5", detail: { part: "play" } },
      { code: "degree.confusion.1-5", detail: { part: "sing" } },
    ]);
  });
});
