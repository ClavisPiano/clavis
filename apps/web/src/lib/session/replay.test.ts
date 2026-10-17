import type { ItemInstance, NoteEvent } from "@clavis/core";
import { describe, expect, it } from "vitest";
import { REPLAY_GAP_SEC, attemptEvents, buildReplaySpec } from "./replay";

const instance = {
  presentation: {},
  stimulus: {
    tempoBpm: 90,
    events: [
      { atSec: 0, midi: [48, 60, 64, 67], durationSec: 0.6, velocity: 0.7, role: "cadence" },
      { atSec: 2.7, midi: [64], durationSec: 1.3, velocity: 0.8, role: "target" },
    ],
  },
} as unknown as ItemInstance;

const note = (pitch: number, onsetMs: number): NoteEvent => ({
  pitch,
  onsetMs,
  confidence: 1,
  source: "mic",
});

describe("buildReplaySpec", () => {
  it("is the reference target (no cadence) then the attempt after a gap", () => {
    const spec = buildReplaySpec(instance, {
      notes: [note(65, 10_000), note(67, 10_500)],
    });
    expect(spec.tempoBpm).toBe(90);
    const [ref, a, b] = spec.events;
    expect(ref).toMatchObject({ atSec: 0, midi: [64], role: "target" });
    expect(a?.atSec).toBeCloseTo(1.3 + REPLAY_GAP_SEC, 5);
    expect(a?.midi).toEqual([65]);
    expect(b?.atSec).toBeCloseTo(1.3 + REPLAY_GAP_SEC + 0.5, 5);
    expect(b?.midi).toEqual([67]);
    expect(spec.events.some((e) => e.role === "cadence")).toBe(false);
  });

  it("leads with the tonic, in the target's register, when the item has one", () => {
    const withTonic = {
      ...instance,
      presentation: { tonicMidi: 60 },
    } as unknown as ItemInstance;
    const spec = buildReplaySpec(withTonic, { notes: [note(65, 0)] });
    const [tonic, target, mine] = spec.events;
    expect(tonic).toMatchObject({ atSec: 0, midi: [60] });
    expect(target).toMatchObject({ midi: [64], role: "target" });
    expect(target?.atSec).toBeGreaterThan(tonic?.durationSec ?? 0);
    expect(mine?.midi).toEqual([65]);
    expect(mine?.atSec).toBeGreaterThan((target?.atSec ?? 0) + 1.3);
  });

  it("does not repeat the tonic when the target is the tonic", () => {
    const one = {
      presentation: { tonicMidi: 64 },
      stimulus: instance.stimulus,
    } as unknown as ItemInstance;
    expect(buildReplaySpec(one, { notes: [] }).events).toHaveLength(1);
  });

  it("falls back to the reference alone when nothing was played", () => {
    const spec = buildReplaySpec(instance, { notes: [] });
    expect(spec.events).toHaveLength(1);
  });
});

describe("attemptEvents", () => {
  it("keeps durations sane", () => {
    const events = attemptEvents({ notes: [note(60, 0), note(62, 100)] });
    expect(events[0]?.durationSec).toBeGreaterThanOrEqual(0.15);
    expect(events[0]?.durationSec).toBeLessThanOrEqual(0.6);
    expect(events[1]?.durationSec).toBeLessThanOrEqual(0.6);
  });
});

describe("replay of chords", () => {
  const chordInstance = {
    presentation: {},
    display: {},
    stimulus: {
      tempoBpm: 60,
      events: [0, 1, 2, 3].map((atSec) => ({
        atSec,
        midi: [84],
        durationSec: 0.1,
        velocity: 0.4,
        role: "count-in",
      })),
    },
    expected: {
      responseWindowMs: 20000,
      play: {
        kind: "chordLine",
        chords: [
          { roman: "I", symbol: "C", midi: [48, 52, 55], onsetBeats: 0, durationBeats: 2 },
          { roman: "V", symbol: "G", midi: [43, 47, 50], onsetBeats: 2, durationBeats: 2 },
        ],
        tempoBpm: 60,
        beatsPerBar: 4,
      },
    },
  } as unknown as ItemInstance;

  it("plays the count-in, then each chord as one event at its beat", () => {
    const spec = buildReplaySpec(chordInstance, { notes: [] });
    const chords = spec.events.filter((e) => e.role === "target");
    expect(chords.map((e) => e.midi)).toEqual([
      [48, 52, 55],
      [43, 47, 50],
    ]);
    expect((chords[1]?.atSec ?? 0) - (chords[0]?.atSec ?? 0)).toBeCloseTo(2, 5);
    expect(spec.events.filter((e) => e.role === "count-in")).toHaveLength(4);
  });

  it("lets the tones of a played chord ring until the next chord, not the next tone", () => {
    const events = attemptEvents({
      notes: [note(48, 0), note(52, 20), note(55, 40), note(43, 2000), note(47, 2020)],
    });
    expect(events).toHaveLength(5);
    for (const e of events.slice(0, 3)) expect(e.durationSec).toBeGreaterThan(0.5);
  });
});

describe("replay of a two-hand performance", () => {
  const performanceInstance = {
    presentation: {},
    display: {},
    stimulus: {
      tempoBpm: 60,
      events: [0, 1, 2, 3].map((atSec) => ({
        atSec,
        midi: [84],
        durationSec: 0.1,
        velocity: 0.4,
        role: "count-in",
      })),
    },
    expected: {
      responseWindowMs: 20000,
      play: {
        kind: "performance",
        notes: [
          { id: "n1", midi: 67, onsetBeats: 0, durationBeats: 1, hand: "rh" },
          { id: "n3.0", midi: 43, onsetBeats: 0, durationBeats: 2, hand: "lh" },
          { id: "n3.1", midi: 47, onsetBeats: 0, durationBeats: 2, hand: "lh" },
          { id: "n2", midi: 69, onsetBeats: 1, durationBeats: 1, hand: "rh" },
        ],
        tempoBpm: 60,
        beatsPerBar: 4,
      },
    },
  } as unknown as ItemInstance;

  it("plays the count-in, then both hands of each onset together", () => {
    const spec = buildReplaySpec(performanceInstance, { notes: [], frames: [] });
    const targets = spec.events.filter((e) => e.role === "target");
    expect(targets.map((e) => e.midi)).toEqual([[67, 43, 47], [69]]);
    expect((targets[1]?.atSec ?? 0) - (targets[0]?.atSec ?? 0)).toBeCloseTo(1, 5);
    expect(spec.events.filter((e) => e.role === "count-in")).toHaveLength(4);
  });
});
