import type { AttemptError, NoteEvent, PerformanceTarget, ScoreSpec } from "@clavis/core";
import { describe, expect, it } from "vitest";
import { expectedFromScore } from "./align/fromScore.js";
import { PERFORMANCE_PASS_OVERALL, scorePerformance } from "./performance.js";
import { scoreAttempt } from "./score.js";

/*
 * A grand-staff performance graded by alignment (R27). Two bars of 4/4 at 60 bpm in C major.
 * RH: E4 D4 C4 D4 | E4 E4 E4 rest. LH: C3 G2 (halves) | a whole C major triad (n10).
 */

type Pitch = ScoreSpec["staves"][number]["measures"][number][number];
const n = (id: string, step: "C" | "D" | "E" | "G", octave: number, value: 1 | 2 | 4): Pitch => ({
  kind: "note",
  id,
  pitches: [{ step, alter: 0, octave }],
  duration: { value, dots: 0 },
});

const SCORE: ScoreSpec = {
  staves: [
    {
      clef: "treble",
      lines: 5,
      measures: [
        [n("n1", "E", 4, 4), n("n2", "D", 4, 4), n("n3", "C", 4, 4), n("n4", "D", 4, 4)],
        [
          n("n5", "E", 4, 4),
          n("n6", "E", 4, 4),
          n("n7", "E", 4, 4),
          { kind: "rest", duration: { value: 4, dots: 0 } },
        ],
      ],
    },
    {
      clef: "bass",
      lines: 5,
      measures: [
        [n("n8", "C", 3, 2), n("n9", "G", 2, 2)],
        [
          {
            kind: "note",
            id: "n10",
            pitches: [
              { step: "C", alter: 0, octave: 3 },
              { step: "E", alter: 0, octave: 3 },
              { step: "G", alter: 0, octave: 3 },
            ],
            duration: { value: 1, dots: 0 },
          },
        ],
      ],
    },
  ],
  key: { tonic: "C", mode: "major" },
  meter: { beats: 4, beatValue: 4 },
};

const TARGET: PerformanceTarget = {
  kind: "performance",
  notes: expectedFromScore(SCORE).map((e) => {
    if (e.hand === undefined) throw new Error("a grand staff note has a hand");
    return { ...e, hand: e.hand };
  }),
  tempoBpm: 60,
  beatsPerBar: 4,
};
const BEAT_MS = 1000;
const WINDOW = 20000;
const START = 600;

interface Play {
  id?: string;
  pitch: number;
  at: number;
}

/** The right answer: every note of both hands on its beat. */
function correct(): Play[] {
  return TARGET.notes.map((x) => ({
    id: x.id,
    pitch: x.midi,
    at: START + x.onsetBeats * BEAT_MS,
  }));
}

/** Change or drop notes by id. */
function tweak(changes: Record<string, (p: Play) => Play | undefined>): Play[] {
  return correct().flatMap((p) => {
    const f = p.id === undefined ? undefined : changes[p.id];
    const out = f === undefined ? p : f(p);
    return out === undefined ? [] : [out];
  });
}

function score(plays: Play[], source: "midi" | "tap" = "midi") {
  const played: NoteEvent[] = plays.map((p) => ({
    pitch: p.pitch,
    onsetMs: p.at,
    confidence: 1,
    source,
  }));
  return scorePerformance({
    notes: TARGET.notes,
    tempoBpm: TARGET.tempoBpm,
    beatsPerBar: TARGET.beatsPerBar,
    played,
    stimulusEndMs: 0,
    responseWindowMs: WINDOW,
    source,
  });
}

const codes = (errors: AttemptError[]): string[] => errors.map((e) => e.code);

describe("expectedFromScore on a grand staff", () => {
  it("reads both staves in onset order and tags each note with its hand", () => {
    expect(
      expectedFromScore(SCORE).map((e) => [e.id, e.midi, e.onsetBeats, e.durationBeats, e.hand]),
    ).toEqual([
      ["n1", 64, 0, 1, "rh"],
      ["n8", 48, 0, 2, "lh"],
      ["n2", 62, 1, 1, "rh"],
      ["n3", 60, 2, 1, "rh"],
      ["n9", 43, 2, 2, "lh"],
      ["n4", 62, 3, 1, "rh"],
      ["n5", 64, 4, 1, "rh"],
      ["n10.0", 48, 4, 4, "lh"],
      ["n10.1", 52, 4, 4, "lh"],
      ["n10.2", 55, 4, 4, "lh"],
      ["n6", 64, 5, 1, "rh"],
      ["n7", 64, 6, 1, "rh"],
    ]);
  });
});

describe("scorePerformance", () => {
  it("passes both hands on the beat", () => {
    const r = score(correct());
    expect(r.outcome.correct).toBe(true);
    expect(r.outcome.partial).toBeGreaterThan(0.95);
    expect(r.outcome.latencyMs).toBe(START);
    expect(r.errors).toEqual([]);
  });

  it("passes a steady slow take", () => {
    const slow = correct().map((p) => ({ ...p, at: START + (p.at - START) * 1.3 }));
    expect(score(slow).outcome.correct).toBe(true);
  });

  const cases: {
    name: string;
    play: () => Play[];
    correct: boolean;
    codes: string[];
    detail: Record<string, unknown>;
  }[] = [
    {
      name: "RH wrong note",
      play: () => tweak({ n2: (p) => ({ ...p, pitch: 64 }) }),
      correct: false,
      codes: ["note.wrong"],
      detail: { id: "n2", measure: 1, beat: 2, hand: "rh", expected: 62, played: 64 },
    },
    {
      name: "LH wrong note",
      play: () => tweak({ n9: (p) => ({ ...p, pitch: 41 }) }),
      correct: false,
      codes: ["note.wrong"],
      detail: { id: "n9", measure: 1, beat: 3, hand: "lh", expected: 43, played: 41 },
    },
    {
      name: "RH missed note",
      play: () => tweak({ n3: () => undefined }),
      correct: false,
      codes: ["note.missed"],
      detail: { id: "n3", measure: 1, beat: 3, hand: "rh", expected: 60 },
    },
    {
      name: "LH missed chord tone",
      play: () => tweak({ "n10.1": () => undefined }),
      correct: false,
      codes: ["note.missed"],
      detail: { id: "n10.1", measure: 2, beat: 1, hand: "lh", expected: 52 },
    },
    {
      name: "RH extra note (one is forgiven)",
      play: () => [...correct(), { pitch: 72, at: START + 5.5 * BEAT_MS }],
      correct: true,
      codes: ["note.extra"],
      detail: { measure: 2, hand: "rh", played: 72 },
    },
    {
      name: "LH extra note (one is forgiven)",
      play: () => [...correct(), { pitch: 36, at: START + 1.5 * BEAT_MS }],
      correct: true,
      codes: ["note.extra"],
      detail: { measure: 1, hand: "lh", played: 36 },
    },
    {
      name: "two extra notes fail",
      play: () => [
        ...correct(),
        { pitch: 36, at: START + 1.5 * BEAT_MS },
        { pitch: 72, at: START + 5.5 * BEAT_MS },
      ],
      correct: false,
      codes: ["note.extra", "note.extra"],
      detail: { measure: 1, hand: "lh" },
    },
    {
      name: "RH early",
      play: () => tweak({ n3: (p) => ({ ...p, at: p.at - 450 }) }),
      correct: true,
      codes: ["note.early"],
      detail: { id: "n3", measure: 1, beat: 3, hand: "rh" },
    },
    {
      name: "RH late",
      play: () => tweak({ n6: (p) => ({ ...p, at: p.at + 450 }) }),
      correct: true,
      codes: ["note.late"],
      detail: { id: "n6", measure: 2, beat: 2, hand: "rh" },
    },
    {
      name: "LH early",
      play: () => tweak({ n9: (p) => ({ ...p, at: p.at - 450 }) }),
      correct: true,
      codes: ["note.early"],
      detail: { id: "n9", measure: 1, beat: 3, hand: "lh" },
    },
    {
      name: "LH chord late is one error",
      play: () =>
        tweak({
          "n10.0": (p) => ({ ...p, at: p.at + 450 }),
          "n10.1": (p) => ({ ...p, at: p.at + 450 }),
          "n10.2": (p) => ({ ...p, at: p.at + 450 }),
        }),
      correct: true,
      codes: ["note.late"],
      detail: { measure: 2, beat: 1, hand: "lh" },
    },
  ];

  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const r = score(c.play());
    expect(codes(r.errors)).toEqual(c.codes);
    expect(r.errors[0]?.detail).toMatchObject(c.detail);
    expect(r.outcome.correct).toBe(c.correct);
    expect(r.outcome.partial).toBeGreaterThanOrEqual(0);
    expect(r.outcome.partial).toBeLessThanOrEqual(1);
  });

  it("orders errors: wrong, missed, extra, then timing", () => {
    const plays = tweak({
      n2: (p) => ({ ...p, pitch: 64 }),
      "n10.1": () => undefined,
      n9: (p) => ({ ...p, at: p.at - 450 }),
    });
    const r = score([...plays, { pitch: 84, at: START + 6.5 * BEAT_MS }]);
    expect(codes(r.errors)).toEqual(["note.wrong", "note.missed", "note.extra", "note.early"]);
    expect(r.outcome.correct).toBe(false);
  });

  it("keeps a wrong note's partial credit at or above the pass mark", () => {
    const perfect = score(correct()).outcome.partial ?? 0;
    const wrong = score(tweak({ n2: (p) => ({ ...p, pitch: 64 }) })).outcome.partial ?? 0;
    expect(wrong).toBeLessThan(perfect);
    expect(wrong).toBeGreaterThanOrEqual(PERFORMANCE_PASS_OVERALL);
  });

  it("times out with nothing played", () => {
    const r = score([]);
    expect(r.outcome.correct).toBe(false);
    expect(r.outcome.latencyMs).toBe(WINDOW);
    expect(r.errors[0]?.code).toBe("response.timeout");
    expect(codes(r.errors)).toContain("note.missed");
  });

  it("ignores notes outside the response window", () => {
    const r = score([...correct(), { pitch: 60, at: WINDOW + 1000 }, { pitch: 61, at: -50 }]);
    expect(r.outcome.correct).toBe(true);
    expect(r.errors).toEqual([]);
  });
});

describe("scoreAttempt with a performance target", () => {
  it("dispatches to the performance scorer", () => {
    const toNotes = (plays: Play[]): NoteEvent[] =>
      plays.map((p) => ({ pitch: p.pitch, onsetMs: p.at, confidence: 1, source: "midi" }));
    const expected = { play: TARGET, responseWindowMs: WINDOW };
    const ok = scoreAttempt({
      expected,
      notes: toNotes(correct()),
      stimulusEndMs: 0,
      source: "midi",
    });
    expect(ok.outcome.correct).toBe(true);
    expect(ok.subScores.play).toBeGreaterThan(0.95);

    const wrong = scoreAttempt({
      expected,
      notes: toNotes(tweak({ n9: (p) => ({ ...p, pitch: 41 }) })),
      stimulusEndMs: 0,
      source: "midi",
    });
    expect(wrong.outcome.correct).toBe(false);
    expect(wrong.errors[0]).toMatchObject({
      code: "note.wrong",
      detail: { hand: "lh", measure: 1 },
    });
  });
});
