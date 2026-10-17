import type { NoteEvent, PlayTarget } from "@clavis/core";
import { describe, expect, it } from "vitest";
import { CHORD_GIVE_UP_MS, MAX_WRONG_NOTES, SEQUENCE_QUIET_MS, checkPlayDone } from "./completion";

const LABELS = ["1", "b2", "2", "b3", "3", "4", "#4", "5", "b6", "6", "b7", "7"];
const note = (pitch: number, onsetMs: number): NoteEvent => ({
  pitch,
  onsetMs,
  confidence: 1,
  source: "mic",
});

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

describe("checkPlayDone for a two-hand performance", () => {
  const performance: PlayTarget = {
    kind: "performance",
    notes: [
      { id: "n1", midi: 67, onsetBeats: 0, durationBeats: 1, hand: "rh" },
      { id: "n3", midi: 43, onsetBeats: 0, durationBeats: 2, hand: "lh" },
      { id: "n2", midi: 69, onsetBeats: 1, durationBeats: 1, hand: "rh" },
    ],
    tempoBpm: 60,
    beatsPerBar: 4,
  };

  it("is not done before anything is played", () => {
    expect(checkPlayDone(performance, [], 10_000).done).toBe(false);
  });

  it("is done once every note is struck and the hands have been still for a moment", () => {
    const all = [note(67, 1000), note(43, 1010), note(69, 2000)];
    const check = checkPlayDone(performance, all, 2100);
    expect(check.done).toBe(false);
    expect(check.recheckInMs).toBe(2000 + SEQUENCE_QUIET_MS - 2100);
    expect(checkPlayDone(performance, all, 2000 + SEQUENCE_QUIET_MS).done).toBe(true);
  });

  it("waits a long pause when notes are still to come", () => {
    const first = [note(67, 1000), note(43, 1010)];
    expect(checkPlayDone(performance, first, 1010 + SEQUENCE_QUIET_MS).done).toBe(false);
    expect(checkPlayDone(performance, first, 1010 + CHORD_GIVE_UP_MS - 1).done).toBe(false);
    expect(checkPlayDone(performance, first, 1010 + CHORD_GIVE_UP_MS).done).toBe(true);
  });
});
