import { describe, expect, it } from "vitest";
import {
  NoteEventSchema,
  PitchFrameSchema,
  StimulusSpecSchema,
  stimulusDurationSec,
  type StimulusSpec,
} from "./index.js";

describe("NoteEvent and PitchFrame", () => {
  const note = { pitch: 60, onsetMs: 10, confidence: 0.9, source: "tap" };
  it("accepts valid notes and rejects bad ones", () => {
    expect(NoteEventSchema.safeParse(note).success).toBe(true);
    expect(NoteEventSchema.safeParse({ ...note, velocity: 127, offsetMs: 50 }).success).toBe(true);
    expect(NoteEventSchema.safeParse({ ...note, pitch: 128 }).success).toBe(false);
    expect(NoteEventSchema.safeParse({ ...note, pitch: 60.5 }).success).toBe(false);
    expect(NoteEventSchema.safeParse({ ...note, confidence: 1.1 }).success).toBe(false);
    expect(NoteEventSchema.safeParse({ ...note, source: "voice" }).success).toBe(false);
  });
  it("allows a null-hz frame", () => {
    expect(PitchFrameSchema.safeParse({ hz: null, confidence: 0, atMs: 5 }).success).toBe(true);
    expect(PitchFrameSchema.safeParse({ hz: 440, cents: -3, confidence: 1, atMs: 5 }).success).toBe(
      true,
    );
    expect(PitchFrameSchema.safeParse({ hz: 440, confidence: 2, atMs: 5 }).success).toBe(false);
  });
});

describe("StimulusSpec", () => {
  const spec: StimulusSpec = {
    tempoBpm: 90,
    events: [
      { atSec: 0, midi: [60, 64, 67], durationSec: 1, velocity: 0.7, role: "cadence" },
      { atSec: 1.5, midi: [72], durationSec: 0.5, velocity: 0.8, role: "target" },
      { atSec: 1, midi: [62], durationSec: 0.25, velocity: 0.5 },
    ],
  };
  it("validates", () => {
    expect(StimulusSpecSchema.safeParse(spec).success).toBe(true);
    const ev = { atSec: 0, midi: [60], durationSec: 1, velocity: 0.7 };
    expect(StimulusSpecSchema.safeParse({ events: [{ ...ev, midi: [] }] }).success).toBe(false);
    expect(StimulusSpecSchema.safeParse({ events: [{ ...ev, atSec: -1 }] }).success).toBe(false);
    expect(StimulusSpecSchema.safeParse({ events: [{ ...ev, durationSec: 0 }] }).success).toBe(
      false,
    );
    expect(StimulusSpecSchema.safeParse({ events: [{ ...ev, velocity: 1.5 }] }).success).toBe(
      false,
    );
    expect(StimulusSpecSchema.safeParse({ events: [{ ...ev, role: "x" }] }).success).toBe(false);
  });
  it("computes duration as the end of the last-finishing note", () => {
    expect(stimulusDurationSec(spec)).toBe(2);
    expect(stimulusDurationSec({ events: [] })).toBe(0);
  });
});
