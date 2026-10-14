import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ExpectedResponse, InputSource, NoteEvent } from "@clavis/core";
import { LINE_PITCH_WEIGHT, scoreAttempt, scoreLine } from "./index";

const END = 1000;
const BPM = 100;
const beatMs = 60000 / BPM;
const MIDI = [64, 62, 60, 62, 64, 64, 64];
const BEATS = [0, 1, 2, 3, 4, 5, 6];

const note = (pitch: number, onsetMs: number, source: InputSource = "midi"): NoteEvent => ({
  pitch,
  onsetMs,
  confidence: 1,
  source,
});

/** The expected line played on the beat from `offset` ms after the reference, one note per entry. */
function played(pitches: readonly number[], offset = 700, scale = 1, source: InputSource = "midi") {
  return pitches.map((p, i) => note(p, END + offset + i * beatMs * scale, source));
}

const score = (notes: NoteEvent[], source: InputSource = "midi") =>
  scoreLine({
    midi: MIDI,
    onsetsBeats: BEATS,
    tempoBpm: BPM,
    notes,
    stimulusEndMs: END,
    responseWindowMs: 20000,
    source,
  });

describe("scoreLine: pitch first, rhythm second", () => {
  it("a perfect performance is correct with a full score and the first note's latency", () => {
    const r = score(played(MIDI));
    expect(r.outcome).toEqual({ correct: true, latencyMs: 700, retries: 0, partial: 1 });
    expect(r.errors).toEqual([]);
  });

  it("accepts a uniformly slower performance but reports the tempo drift", () => {
    const r = score(played(MIDI, 700, 1.3));
    expect(r.outcome.correct).toBe(true);
    expect(r.errors.map((e) => e.code)).toEqual(["rhythm.tempo-drift"]);
  });

  it("a wrong note is a pitch error only, and rhythm is not judged", () => {
    const wrong = [...MIDI];
    wrong[2] = 61;
    // Deliberately ragged timing as well: it must not be reported.
    const notes = wrong.map((p, i) => note(p, END + 700 + i * beatMs + (i % 2 === 0 ? 0 : 150)));
    const r = score(notes);
    expect(r.outcome.correct).toBe(false);
    expect(r.errors.map((e) => e.code)).toEqual(["sequence.wrong-note"]);
    expect(r.errors[0]?.detail).toMatchObject({ index: 2, expected: 60, played: 61 });
    expect(r.outcome.partial).toBeCloseTo(LINE_PITCH_WEIGHT * (6 / 7), 10);
  });

  it("the right pitch class in the wrong octave is a pitch error", () => {
    const octave = [...MIDI];
    octave[0] = 76;
    const r = score(played(octave));
    expect(r.outcome.correct).toBe(false);
    expect(r.errors[0]).toMatchObject({
      code: "sequence.wrong-note",
      detail: { index: 0, octave: true },
    });
  });

  it("a missing last note is reported as missing", () => {
    const r = score(played(MIDI.slice(0, -1)));
    expect(r.outcome.correct).toBe(false);
    expect(r.errors.map((e) => e.code)).toEqual(["sequence.missing"]);
  });

  it("an extra note is reported as extra", () => {
    const r = score(played([...MIDI, 67]));
    expect(r.outcome.correct).toBe(false);
    expect(r.errors.map((e) => e.code)).toEqual(["sequence.extra"]);
  });

  it("right notes with one note well off the beat are incorrect on rhythm, with a high partial", () => {
    const notes = played(MIDI);
    notes[3] = note(62, END + 700 + 3 * beatMs + 250);
    const r = score(notes);
    expect(r.outcome.correct).toBe(false);
    expect(r.errors.map((e) => e.code)).toEqual(["rhythm.late"]);
    expect(r.errors[0]?.detail).toMatchObject({ index: 3 });
    const partial = r.outcome.partial ?? 0;
    expect(partial).toBeGreaterThan(LINE_PITCH_WEIGHT);
    expect(partial).toBeLessThan(1);
  });

  it("nothing played is a timeout with a zero score", () => {
    const r = score([]);
    expect(r.outcome).toEqual({ correct: false, latencyMs: 20000, retries: 0, partial: 0 });
    expect(r.errors[0]?.code).toBe("response.timeout");
  });

  it("a note before the reference time does not count", () => {
    const r = score([note(64, END - 100), ...played(MIDI.slice(1), 1700)]);
    expect(r.outcome.correct).toBe(false);
  });

  it("uses the looser tolerance for the mic than for MIDI", () => {
    // One note 80 ms late: past the MIDI tolerance (60 ms), inside the mic's (100 ms).
    const lateOne = (source: InputSource) => {
      const notes = played(MIDI, 700, 1, source);
      notes[3] = note(62, END + 700 + 3 * beatMs + 80, source);
      return score(notes, source);
    };
    expect(lateOne("midi").outcome.correct).toBe(false);
    expect(lateOne("midi").errors.map((e) => e.code)).toEqual(["rhythm.late"]);
    expect(lateOne("mic").outcome.correct).toBe(true);
  });
});

describe("scoreAttempt with a line target", () => {
  const expected: ExpectedResponse = {
    play: { kind: "line", midi: MIDI, onsetsBeats: BEATS, tempoBpm: BPM, beatsPerBar: 4 },
    responseWindowMs: 20000,
  };

  it("scores the play part and reports it in the sub-scores", () => {
    const r = scoreAttempt({
      expected,
      notes: played(MIDI),
      stimulusEndMs: END,
      source: "midi",
    });
    expect(r.outcome.correct).toBe(true);
    expect(r.subScores).toEqual({ play: 1 });
  });

  it("tags errors as played", () => {
    const r = scoreAttempt({
      expected,
      notes: played(MIDI.slice(0, 3)),
      stimulusEndMs: END,
      source: "midi",
    });
    expect(r.outcome.correct).toBe(false);
    expect(r.errors.every((e) => e.detail?.part === "play")).toBe(true);
  });
});

describe("scoreLine properties", () => {
  it("a wrong note never scores above the pitch ceiling, and a correct line always scores 1", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: MIDI.length - 1 }),
        fc.integer({ min: 1, max: 11 }),
        (index, delta) => {
          const wrong = [...MIDI];
          wrong[index] = (wrong[index] ?? 60) + delta;
          const r = score(played(wrong));
          expect(r.outcome.correct).toBe(false);
          expect(r.outcome.partial ?? 0).toBeLessThanOrEqual(LINE_PITCH_WEIGHT);
          expect(r.errors.map((e) => e.code)).not.toContain("rhythm.late");
        },
      ),
    );
    expect(score(played(MIDI)).outcome.partial).toBe(1);
  });
});
