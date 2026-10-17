import type { NoteEvent, PitchFrame, PlayTarget, SingTarget } from "@clavis/core";
import { describe, expect, it } from "vitest";
import {
  CHORD_GIVE_UP_MS,
  MAX_WRONG_NOTES,
  SEQUENCE_QUIET_MS,
  SUNG_QUIET_MS,
  checkPlayDone,
  checkSingDone,
} from "./completion";

const LABELS = ["1", "b2", "2", "b3", "3", "4", "#4", "5", "b6", "6", "b7", "7"];
const note = (pitch: number, onsetMs: number): NoteEvent => ({
  pitch,
  onsetMs,
  confidence: 1,
  source: "mic",
});
const frames = (midi: number, start: number, ms: number): PitchFrame[] => {
  const hz = 440 * 2 ** ((midi - 69) / 12);
  const out: PitchFrame[] = [];
  for (let t = 0; t <= ms; t += 20) out.push({ hz, confidence: 1, atMs: start + t });
  return out;
};

describe("checkPlayDone", () => {
  const pitchClass: PlayTarget = { kind: "pitchClass", targetMidi: 64, degreeLabels: LABELS };

  it("pitch class: done on the first correct note, in any octave", () => {
    expect(checkPlayDone(pitchClass, [], 0).done).toBe(false);
    expect(checkPlayDone(pitchClass, [note(60, 10)], 20).done).toBe(false);
    expect(checkPlayDone(pitchClass, [note(60, 10), note(76, 20)], 30).done).toBe(true);
  });

  it(`pitch class: done after ${String(MAX_WRONG_NOTES)} wrong notes`, () => {
    const wrong = [note(60, 1), note(61, 2), note(62, 3)];
    expect(checkPlayDone(pitchClass, wrong.slice(0, 2), 10).done).toBe(false);
    expect(checkPlayDone(pitchClass, wrong, 10).done).toBe(true);
  });

  it("exact pitch needs the right octave", () => {
    const t: PlayTarget = { kind: "exactPitch", targetMidi: 64 };
    expect(checkPlayDone(t, [note(76, 1)], 10).done).toBe(false);
    expect(checkPlayDone(t, [note(64, 1)], 10).done).toBe(true);
  });

  it("sequence: enough notes, then 800 ms of quiet", () => {
    const t: PlayTarget = {
      kind: "sequence",
      midi: [60, 62, 64],
      octaveAgnostic: true,
      degreeLabels: LABELS,
    };
    const notes = [note(60, 1000), note(62, 1400)];
    expect(checkPlayDone(t, notes, 5000).done).toBe(false);
    const all = [...notes, note(64, 1800)];
    expect(checkPlayDone(t, all, 1900)).toEqual({
      done: false,
      recheckInMs: 1800 + SEQUENCE_QUIET_MS - 1900,
    });
    expect(checkPlayDone(t, all, 1800 + SEQUENCE_QUIET_MS).done).toBe(true);
  });

  it("choice: never done from notes, however many arrive", () => {
    const target: PlayTarget = {
      kind: "choice",
      options: [
        { id: "major", label: "Major" },
        { id: "minor", label: "Minor" },
      ],
      correct: "major",
    };
    const stray = [note(60, 100), note(64, 200), note(67, 300), note(72, 400)];
    expect(checkPlayDone(target, stray, 10_000)).toEqual({ done: false });
    expect(checkPlayDone(target, [], 10_000)).toEqual({ done: false });
  });

  it("rhythm: expected count of onsets, then one beat of quiet", () => {
    const t: PlayTarget = {
      kind: "rhythm",
      onsetsBeats: [0, 1, 2],
      tempoBpm: 120,
      beatsPerBar: 4,
    };
    const notes = [note(60, 0), note(60, 500)];
    expect(checkPlayDone(t, notes, 9999).done).toBe(false);
    const all = [...notes, note(60, 1000)];
    expect(checkPlayDone(t, all, 1400)).toEqual({ done: false, recheckInMs: 100 });
    expect(checkPlayDone(t, all, 1500).done).toBe(true);
  });
});

describe("checkSingDone", () => {
  const pitch: SingTarget = { kind: "sungPitch", targetMidi: 60, toleranceCents: 50 };
  const seq: SingTarget = { kind: "sungSequence", midi: [60, 64], toleranceCents: 50 };

  it("single pitch: done once a stable segment exists", () => {
    expect(checkSingDone(pitch, [], 0).done).toBe(false);
    expect(checkSingDone(pitch, frames(60, 1000, 100), 1100).done).toBe(false);
    expect(checkSingDone(pitch, frames(60, 1000, 300), 1300).done).toBe(true);
  });

  it("single pitch: unvoiced or low-confidence frames never complete", () => {
    const quiet: PitchFrame[] = [];
    for (let t = 0; t < 500; t += 20) quiet.push({ hz: null, confidence: 0, atMs: t });
    expect(checkSingDone(pitch, quiet, 500).done).toBe(false);
  });

  it("sequence: all notes sung, then the voice stops", () => {
    const one = frames(60, 1000, 300);
    expect(checkSingDone(seq, one, 5000).done).toBe(false);
    const both = [...one, ...frames(64, 1400, 300)];
    const check = checkSingDone(seq, both, 1800);
    expect(check.done).toBe(false);
    expect(check.recheckInMs).toBe(1700 + SUNG_QUIET_MS - 1800);
    expect(checkSingDone(seq, both, 1700 + SUNG_QUIET_MS).done).toBe(true);
  });
});

describe("checkPlayDone for a chord line", () => {
  const chordLine: PlayTarget = {
    kind: "chordLine",
    chords: [
      { roman: "I", symbol: "C", midi: [48, 52, 55], onsetBeats: 0, durationBeats: 2 },
      { roman: "V", symbol: "G", midi: [43, 47, 50], onsetBeats: 2, durationBeats: 2 },
    ],
    tempoBpm: 60,
    beatsPerBar: 4,
  };
  const chord = (midi: number[], at: number): NoteEvent[] => midi.map((m) => note(m, at));

  it("is not done before anything is played", () => {
    expect(checkPlayDone(chordLine, [], 10_000).done).toBe(false);
  });

  it("is done once every tone is struck and the hand has been still for a moment", () => {
    const all = [...chord([48, 52, 55], 1000), ...chord([43, 47, 50], 3000)];
    const check = checkPlayDone(chordLine, all, 3100);
    expect(check.done).toBe(false);
    expect(check.recheckInMs).toBe(3000 + SEQUENCE_QUIET_MS - 3100);
    expect(checkPlayDone(chordLine, all, 3000 + SEQUENCE_QUIET_MS).done).toBe(true);
  });

  it("waits a long pause when tones are still to come, so a slow chord change is not cut off", () => {
    const first = chord([48, 52, 55], 1000);
    expect(checkPlayDone(chordLine, first, 1000 + SEQUENCE_QUIET_MS).done).toBe(false);
    expect(checkPlayDone(chordLine, first, 1000 + CHORD_GIVE_UP_MS - 1).done).toBe(false);
    expect(checkPlayDone(chordLine, first, 1000 + CHORD_GIVE_UP_MS).done).toBe(true);
  });
});

describe("checkPlayDone for one chord read from the staff (T5.10)", () => {
  // No count-in: the chord may come at any time after the score is shown.
  const one: PlayTarget = {
    kind: "chordLine",
    chords: [{ roman: "IV", symbol: "F/A", midi: [45, 48, 53], onsetBeats: 0, durationBeats: 4 }],
    tempoBpm: 60,
    beatsPerBar: 4,
    gradeTiming: false,
    showLabels: false,
  };
  const at = (midi: number[], ms: number): NoteEvent[] => midi.map((m) => note(m, ms));

  it("waits however long the learner takes to start", () => {
    expect(checkPlayDone(one, [], 9_000).done).toBe(false);
  });

  it("is done a moment after the three tones, wherever they fall", () => {
    const chord = at([45, 48, 53], 4_200);
    expect(checkPlayDone(one, chord, 4_200 + SEQUENCE_QUIET_MS - 1).done).toBe(false);
    expect(checkPlayDone(one, chord, 4_200 + SEQUENCE_QUIET_MS).done).toBe(true);
  });

  it("counts the last tone of a chord found one finger at a time", () => {
    const chord = [note(45, 2_000), note(48, 2_150), note(53, 2_300)];
    expect(checkPlayDone(one, chord, 2_000 + SEQUENCE_QUIET_MS).done).toBe(false);
    expect(checkPlayDone(one, chord, 2_300 + SEQUENCE_QUIET_MS).done).toBe(true);
  });

  it("gives up after a long pause with a tone still missing", () => {
    const two = at([45, 48], 2_000);
    expect(checkPlayDone(one, two, 2_000 + SEQUENCE_QUIET_MS).done).toBe(false);
    expect(checkPlayDone(one, two, 2_000 + CHORD_GIVE_UP_MS).done).toBe(true);
  });
});
