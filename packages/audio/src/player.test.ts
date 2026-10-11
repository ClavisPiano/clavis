import type { StimulusSpec } from "@clavis/core";
import { describe, expect, it } from "vitest";
import { FakeInstrument } from "./instrument";
import { StimulusPlayer, endTime, scheduleNotes } from "./player";
import { PIANO_VELOCITY_RANGE, mapVelocity } from "./smplr-piano";

const spec: StimulusSpec = {
  events: [
    { atSec: 0, midi: [60, 64, 67], durationSec: 0.5, velocity: 0.8 },
    { atSec: 0.5, midi: [65], durationSec: 0.25, velocity: 0.4 },
    { atSec: 1, midi: [60, 72], durationSec: 1.5, velocity: 1 },
  ],
};

describe("scheduleNotes", () => {
  it("offsets every event from startAt and expands chords into simultaneous notes", () => {
    const notes = scheduleNotes(spec, 10);
    expect(notes).toHaveLength(6);
    expect(notes.filter((n) => n.time === 10).map((n) => n.midi)).toEqual([60, 64, 67]);
    expect(notes.find((n) => n.midi === 65)).toEqual({
      midi: 65,
      time: 10.5,
      duration: 0.25,
      velocity: 0.4,
    });
    expect(notes.filter((n) => n.time === 11).map((n) => n.midi)).toEqual([60, 72]);
  });

  it("orders notes by time even when events are out of order", () => {
    const shuffled: StimulusSpec = { events: [...spec.events].reverse() };
    const times = scheduleNotes(shuffled, 0).map((n) => n.time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("clamps velocity into 0..1", () => {
    const s: StimulusSpec = {
      events: [
        { atSec: 0, midi: [60], durationSec: 1, velocity: 1.7 },
        { atSec: 0, midi: [61], durationSec: 1, velocity: -0.2 },
      ],
    };
    expect(scheduleNotes(s, 0).map((n) => n.velocity)).toEqual([1, 0]);
  });

  it("returns nothing for an empty spec", () => {
    expect(scheduleNotes({ events: [] }, 3)).toEqual([]);
  });
});

describe("endTime", () => {
  it("is startAt plus the end of the last note to finish", () => {
    // The long final chord ends at 1 + 1.5.
    expect(endTime(spec, 10)).toBe(12.5);
    const notes = scheduleNotes(spec, 10);
    expect(Math.max(...notes.map((n) => n.time + n.duration))).toBe(endTime(spec, 10));
  });

  it("uses the longest tail, not the last onset", () => {
    const s: StimulusSpec = {
      events: [
        { atSec: 0, midi: [60], durationSec: 4, velocity: 1 },
        { atSec: 1, midi: [62], durationSec: 0.5, velocity: 1 },
      ],
    };
    expect(endTime(s, 2)).toBe(6);
  });

  it("equals startAt for an empty spec", () => {
    expect(endTime({ events: [] }, 5)).toBe(5);
  });
});

describe("mapVelocity", () => {
  const [lo, hi] = PIANO_VELOCITY_RANGE;
  it("maps 0..1 onto the shipped layer range", () => {
    expect(mapVelocity(0)).toBe(lo);
    expect(mapVelocity(1)).toBe(hi);
    expect(mapVelocity(0.5)).toBe(Math.round((lo + hi) / 2));
  });
  it("clamps out-of-range input", () => {
    expect(mapVelocity(-3)).toBe(lo);
    expect(mapVelocity(9)).toBe(hi);
  });
});

describe("StimulusPlayer", () => {
  it("defaults startAt to currentTime + 0.1 and starts every note", () => {
    const clock = { currentTime: 4 };
    const inst = new FakeInstrument();
    const player = new StimulusPlayer(clock, inst);
    const r = player.play(spec);
    expect(r.startAt).toBeCloseTo(4.1);
    expect(r.endAt).toBeCloseTo(6.6);
    expect(inst.started).toHaveLength(6);
    expect(inst.started[0]).toEqual({ midi: 60, time: r.startAt, duration: 0.5, velocity: 0.8 });
  });

  it("honours leadInSec and an explicit startAt", () => {
    const clock = { currentTime: 1 };
    const player = new StimulusPlayer(clock, new FakeInstrument());
    expect(player.play(spec, { leadInSec: 0.5 }).startAt).toBe(1.5);
    expect(player.play(spec, { startAt: 20, leadInSec: 0.5 }).startAt).toBe(20);
  });

  it("stop() cancels everything on the instrument", () => {
    const inst = new FakeInstrument();
    const player = new StimulusPlayer({ currentTime: 0 }, inst);
    player.play(spec);
    player.stop();
    expect(inst.stops).toEqual([undefined]);
  });

  it("load() loads the instrument", async () => {
    const inst = new FakeInstrument();
    await new StimulusPlayer({ currentTime: 0 }, inst).load();
    expect(inst.loadCalls).toBe(1);
  });
});
