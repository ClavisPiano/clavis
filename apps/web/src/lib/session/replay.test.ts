import type { ItemInstance, NoteEvent, PitchFrame } from "@clavis/core";
import { describe, expect, it } from "vitest";
import { REPLAY_GAP_SEC, attemptEvents, buildReplaySpec } from "./replay";

const instance = {
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
      frames: [],
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

  it("falls back to the reference alone when nothing was played or sung", () => {
    const spec = buildReplaySpec(instance, { notes: [], frames: [] });
    expect(spec.events).toHaveLength(1);
  });
});

describe("attemptEvents", () => {
  it("converts sung segments to MIDI notes", () => {
    const frames: PitchFrame[] = [];
    const hz = (m: number): number => 440 * 2 ** ((m - 69) / 12);
    for (let t = 0; t <= 400; t += 20) frames.push({ hz: hz(60), confidence: 1, atMs: 1000 + t });
    for (let t = 0; t <= 400; t += 20) frames.push({ hz: hz(64), confidence: 1, atMs: 1600 + t });
    const events = attemptEvents({ notes: [], frames });
    expect(events.map((e) => e.midi[0])).toEqual([60, 64]);
    expect(events[0]?.atSec).toBe(0);
    expect(events[1]?.atSec).toBeCloseTo(0.6, 5);
  });

  it("prefers played notes over sung frames and keeps durations sane", () => {
    const events = attemptEvents({ notes: [note(60, 0), note(62, 100)], frames: [] });
    expect(events[0]?.durationSec).toBeGreaterThanOrEqual(0.15);
    expect(events[0]?.durationSec).toBeLessThanOrEqual(0.6);
    expect(events[1]?.durationSec).toBeLessThanOrEqual(0.6);
  });
});
