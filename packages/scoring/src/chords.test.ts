import type { AttemptError, ChordLineTarget, NoteEvent } from "@clavis/core";
import { describe, expect, it } from "vitest";
import { CHORD_PASS_OVERALL, scoreChordLine } from "./chords.js";
import { scoreAttempt } from "./score.js";

/* A progression of block chords graded by alignment (T5.3): I IV V I in C, half notes at 60 bpm. */

const CHORDS: ChordLineTarget["chords"] = [
  { roman: "I", symbol: "C", midi: [48, 52, 55], onsetBeats: 0, durationBeats: 2 },
  { roman: "IV", symbol: "F", midi: [41, 45, 48], onsetBeats: 2, durationBeats: 2 },
  { roman: "V", symbol: "G", midi: [43, 47, 50], onsetBeats: 4, durationBeats: 2 },
  { roman: "I", symbol: "C", midi: [48, 52, 55], onsetBeats: 6, durationBeats: 2 },
];
const TEMPO = 60;
const BEAT_MS = 1000;
const WINDOW = 24000;
const START = 600;

interface Play {
  pitch: number;
  at: number;
}

/** The right answer: every tone of every chord struck together, on the beat. */
function correct(): Play[] {
  return CHORDS.flatMap((c) =>
    c.midi.map((pitch) => ({ pitch, at: START + c.onsetBeats * BEAT_MS })),
  );
}

/** A chord with its tones replaced or removed, for building a flawed take. */
function tweak(plays: Play[], f: (p: Play, i: number) => Play | undefined): Play[] {
  return plays.flatMap((p, i) => {
    const out = f(p, i);
    return out === undefined ? [] : [out];
  });
}

function score(plays: Play[], source: "midi" | "tap" = "midi") {
  const notes: NoteEvent[] = plays.map((p) => ({
    pitch: p.pitch,
    onsetMs: p.at,
    confidence: 1,
    source,
  }));
  return scoreChordLine({
    chords: CHORDS,
    tempoBpm: TEMPO,
    notes,
    stimulusEndMs: 0,
    responseWindowMs: WINDOW,
    source,
  });
}

const codes = (errors: AttemptError[]): string[] => errors.map((e) => e.code);

describe("scoreChordLine", () => {
  it("passes every chord tone struck together on the beat", () => {
    const r = score(correct());
    expect(r.outcome.correct).toBe(true);
    expect(r.outcome.partial).toBeGreaterThan(0.95);
    expect(r.outcome.latencyMs).toBe(START);
    expect(r.errors).toEqual([]);
  });

  it("passes the same take on the on-screen keys", () => {
    expect(score(correct(), "tap").outcome.correct).toBe(true);
  });

  const cases: {
    name: string;
    play: () => Play[];
    correct: boolean;
    codes: string[];
    detail?: Record<string, unknown>;
  }[] = [
    {
      name: "one wrong tone (E for F in the IV chord)",
      // The IV chord is F A C; E is played in place of F.
      play: () => tweak(correct(), (p) => (p.pitch === 41 ? { ...p, pitch: 40 } : p)),
      correct: false,
      codes: ["chord.wrong-tone"],
      detail: { index: 1, roman: "IV", symbol: "F", expected: 41, played: 40 },
    },
    {
      name: "a whole chord missed",
      play: () => tweak(correct(), (p) => (p.at === START + 4 * BEAT_MS ? undefined : p)),
      correct: false,
      codes: ["chord.missed"],
      detail: { index: 2, roman: "V", symbol: "G" },
    },
    {
      name: "one tone left out of a chord",
      play: () => tweak(correct(), (p) => (p.pitch === 52 && p.at === START ? undefined : p)),
      correct: false,
      codes: ["chord.missing-tone"],
      detail: { index: 0, roman: "I", symbol: "C", expected: 52 },
    },
    {
      name: "the chord an octave too high is wrong tones, not a pass",
      play: () =>
        tweak(correct(), (p) => (p.at === START + 2 * BEAT_MS ? { ...p, pitch: p.pitch + 12 } : p)),
      correct: false,
      codes: ["chord.wrong-tone", "chord.wrong-tone", "chord.wrong-tone"],
    },
    {
      name: "a chord repeated is extra notes",
      play: () => [
        ...correct(),
        ...(CHORDS[3]?.midi ?? []).map((pitch) => ({ pitch, at: START + 8 * BEAT_MS })),
      ],
      correct: false,
      codes: ["chord.extra"],
      detail: { count: 3 },
    },
    {
      name: "one grazed key is forgiven but named",
      play: () => [...correct(), { pitch: 60, at: START + 3 * BEAT_MS }],
      correct: true,
      codes: ["chord.extra"],
      detail: { count: 1, played: 60 },
    },
    {
      name: "chords rolled over 40 ms count as chords",
      play: () => tweak(correct(), (p, i) => ({ ...p, at: p.at + (i % 3) * 20 })),
      correct: true,
      codes: [],
    },
    {
      name: "a chord rolled upwards from the root, 30 ms per tone",
      play: () =>
        tweak(correct(), (p, i) => (i >= 3 && i < 6 ? { ...p, at: p.at + (i - 3) * 30 } : p)),
      correct: true,
      codes: [],
    },
    {
      name: "a steady slow take is not late chord after chord",
      play: () => tweak(correct(), (p) => ({ ...p, at: START + (p.at - START) * 1.4 })),
      correct: true,
      codes: [],
    },
    {
      name: "one chord struck well behind the beat",
      play: () =>
        tweak(correct(), (p) => (p.at === START + 4 * BEAT_MS ? { ...p, at: p.at + 450 } : p)),
      correct: true,
      codes: ["chord.late"],
      detail: { index: 2, roman: "V", symbol: "G" },
    },
  ];

  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const r = score(c.play());
    expect(r.outcome.correct).toBe(c.correct);
    expect(codes(r.errors)).toEqual(c.codes);
    if (c.detail !== undefined) expect(r.errors[0]?.detail).toMatchObject(c.detail);
    expect(r.outcome.partial).toBeGreaterThanOrEqual(0);
    expect(r.outcome.partial).toBeLessThanOrEqual(1);
  });

  it("scores a flawed take below a perfect one, and a wrong tone above a missed chord", () => {
    const perfect = score(correct()).outcome.partial ?? 0;
    const wrongTone =
      score(tweak(correct(), (p) => (p.pitch === 41 ? { ...p, pitch: 40 } : p))).outcome.partial ??
      0;
    const missedChord =
      score(tweak(correct(), (p) => (p.at === START + 4 * BEAT_MS ? undefined : p))).outcome
        .partial ?? 0;
    expect(wrongTone).toBeLessThan(perfect);
    expect(missedChord).toBeLessThan(wrongTone);
    expect(wrongTone).toBeGreaterThanOrEqual(CHORD_PASS_OVERALL);
  });

  it("orders errors by importance: wrong tones, then missed chords, then extras", () => {
    const plays = tweak(correct(), (p) => {
      if (p.pitch === 41) return { ...p, pitch: 40 };
      if (p.at === START + 4 * BEAT_MS) return undefined;
      return p;
    });
    const r = score([...plays, { pitch: 70, at: START + 3 * BEAT_MS }]);
    expect(codes(r.errors)).toEqual(["chord.wrong-tone", "chord.missed", "chord.extra"]);
    expect(r.outcome.correct).toBe(false);
  });

  it("times out with nothing played", () => {
    const r = score([]);
    expect(r.outcome.correct).toBe(false);
    expect(r.outcome.latencyMs).toBe(WINDOW);
    expect(r.errors[0]?.code).toBe("response.timeout");
    expect(r.errors.map((e) => e.code)).toContain("chord.missed");
  });

  it("ignores notes outside the response window", () => {
    const r = score([...correct(), { pitch: 60, at: WINDOW + 1000 }, { pitch: 61, at: -50 }]);
    expect(r.outcome.correct).toBe(true);
    expect(r.errors).toEqual([]);
  });
});

describe("scoreAttempt with a chordLine target", () => {
  it("dispatches to the chord scorer and reports a play sub-score", () => {
    const notes: NoteEvent[] = correct().map((p) => ({
      pitch: p.pitch,
      onsetMs: p.at,
      confidence: 1,
      source: "midi",
    }));
    const r = scoreAttempt({
      expected: {
        play: { kind: "chordLine", chords: CHORDS, tempoBpm: TEMPO, beatsPerBar: 4 },
        responseWindowMs: WINDOW,
      },
      notes,
      stimulusEndMs: 0,
      source: "midi",
    });
    expect(r.outcome.correct).toBe(true);
    expect(r.subScores.play).toBeGreaterThan(0.95);

    const wrong = scoreAttempt({
      expected: {
        play: { kind: "chordLine", chords: CHORDS, tempoBpm: TEMPO, beatsPerBar: 4 },
        responseWindowMs: WINDOW,
      },
      notes: notes.map((n) => (n.pitch === 41 ? { ...n, pitch: 40 } : n)),
      stimulusEndMs: 0,
      source: "midi",
    });
    expect(wrong.outcome.correct).toBe(false);
    expect(wrong.errors[0]?.code).toBe("chord.wrong-tone");
  });
});

/*
 * A chord read from the bass staff (T5.10): one chord, graded on its tones only. F major in first
 * inversion, A2 C3 F3, held as a whole note; the score was shown at 0.
 */
describe("scoreChordLine with gradeTiming false (one chord, tones only)", () => {
  const ONE: ChordLineTarget["chords"] = [
    { roman: "IV", symbol: "F/A", midi: [45, 48, 53], onsetBeats: 0, durationBeats: 4 },
  ];
  const AT = 2400;
  const block = (at = AT): Play[] => [45, 48, 53].map((pitch) => ({ pitch, at }));

  function tones(plays: Play[], gradeTiming = false, offsetAfterMs?: number) {
    return scoreChordLine({
      chords: ONE,
      tempoBpm: 60,
      notes: plays.map((p) => ({
        pitch: p.pitch,
        onsetMs: p.at,
        ...(offsetAfterMs === undefined ? {} : { offsetMs: p.at + offsetAfterMs }),
        confidence: 1,
        source: "midi" as const,
      })),
      stimulusEndMs: 0,
      responseWindowMs: 10000,
      source: "midi",
      gradeTiming,
    });
  }

  const cases: {
    name: string;
    play: () => Play[];
    correct: boolean;
    codes: string[];
    detail?: Record<string, unknown>;
  }[] = [
    { name: "the chord played together", play: () => block(), correct: true, codes: [] },
    {
      name: "the chord found one finger at a time over 250 ms",
      play: () => block().map((p, i) => ({ ...p, at: p.at + i * 125 })),
      correct: true,
      codes: [],
    },
    {
      name: "the chord played late in the window is not late",
      play: () => block(9000),
      correct: true,
      codes: [],
    },
    {
      name: "a wrong tone (G for F)",
      play: () => tweak(block(), (p) => (p.pitch === 53 ? { ...p, pitch: 55 } : p)),
      correct: false,
      codes: ["chord.wrong-tone"],
      detail: { index: 0, roman: "IV", symbol: "F/A", expected: 53, played: 55 },
    },
    {
      name: "the root position instead of the first inversion",
      play: () => tweak(block(), (p) => (p.pitch === 53 ? { ...p, pitch: 41 } : p)),
      correct: false,
      codes: ["chord.wrong-tone"],
      detail: { expected: 53, played: 41 },
    },
    {
      name: "the right chord an octave too low",
      play: () => block().map((p) => ({ ...p, pitch: p.pitch - 12 })),
      correct: false,
      codes: ["chord.wrong-tone", "chord.wrong-tone", "chord.wrong-tone"],
    },
    {
      name: "a tone left out",
      play: () => tweak(block(), (p) => (p.pitch === 48 ? undefined : p)),
      correct: false,
      codes: ["chord.missing-tone"],
      detail: { expected: 48 },
    },
    {
      name: "one stray key before the chord is forgiven but named",
      play: () => [{ pitch: 40, at: 1200 }, ...block()],
      correct: true,
      codes: ["chord.extra"],
      detail: { count: 1, played: 40 },
    },
    {
      name: "a wrong chord, then the right one",
      play: () => [...block(1200).map((p) => ({ ...p, pitch: p.pitch + 2 })), ...block()],
      correct: false,
      codes: ["chord.extra"],
      detail: { count: 3 },
    },
  ];

  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const r = tones(c.play());
    expect(r.outcome.correct).toBe(c.correct);
    expect(codes(r.errors)).toEqual(c.codes);
    if (c.detail !== undefined) expect(r.errors[0]?.detail).toMatchObject(c.detail);
    expect(r.outcome.partial).toBeGreaterThanOrEqual(0);
    expect(r.outcome.partial).toBeLessThanOrEqual(1);
  });

  it("never reports timing, and scores a right chord 1 however it was held", () => {
    for (const held of [50, 400, 3000]) {
      const r = tones(block(), false, held);
      expect(r.outcome.correct).toBe(true);
      expect(r.outcome.partial).toBe(1);
    }
    const rolled = block().map((p, i) => ({ ...p, at: p.at + i * 125 }));
    expect(tones(rolled).outcome.partial).toBe(1);
    // Graded for timing, the same rolled chord is three onsets, not one chord.
    expect(tones(rolled, true).outcome.correct).toBe(false);
  });

  it("measures latency from the score being shown, to the first note", () => {
    expect(tones(block()).outcome.latencyMs).toBe(AT);
    expect(tones([{ pitch: 40, at: 1200 }, ...block()]).outcome.latencyMs).toBe(1200);
  });

  it("times out with nothing played", () => {
    const r = tones([]);
    expect(r.outcome.correct).toBe(false);
    expect(r.outcome.latencyMs).toBe(10000);
    expect(codes(r.errors)).toEqual(["response.timeout", "chord.missed"]);
  });

  it("is passed through by scoreAttempt from the target", () => {
    const notes: NoteEvent[] = block().map((p, i) => ({
      pitch: p.pitch,
      onsetMs: p.at + i * 125,
      confidence: 1,
      source: "midi",
    }));
    const target = { kind: "chordLine", chords: ONE, tempoBpm: 60, beatsPerBar: 4 } as const;
    const run = (gradeTiming?: boolean) =>
      scoreAttempt({
        expected: {
          play: gradeTiming === undefined ? target : { ...target, gradeTiming },
          responseWindowMs: 10000,
        },
        notes,
        stimulusEndMs: 0,
        source: "midi",
      }).outcome.correct;
    expect(run(false)).toBe(true);
    expect(run()).toBe(false);
  });
});
