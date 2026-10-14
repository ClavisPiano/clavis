import { describe, expect, it } from "vitest";
import { createRng } from "../random.js";
import type { SkillNode } from "../graph/schema.js";
import { onsetsFromDurations } from "./rhythm-read.js";
import { RHYTHM_PATTERNS, rhythmEcho, rhythmStaff } from "./rhythm.js";

const node: SkillNode = {
  id: "ear.rhythm.echo",
  strand: "EAR",
  title: "Rhythm echo",
  prerequisites: [],
  mastery: { minAccuracy: 0.9, windowAttempts: 20, distinctSessions: 2 },
  keyDependent: false,
  itemGenerators: ["rhythmEcho"],
  params: { bars: [1, 2], meter: "4/4" },
};

describe("rhythmStaff", () => {
  it.each(RHYTHM_PATTERNS.map((p) => [p.id, p] as const))(
    "%s is written so that its onsets are the pattern's onsets",
    (_id, pat) => {
      const staff = rhythmStaff(pat);
      expect(staff).toBeDefined();
      const measures = (staff?.staves[0]?.measures ?? []).map((bar) =>
        bar.flatMap((note) => (note.kind === "note" ? [note.duration] : [])),
      );
      expect(measures).toHaveLength(pat.bars);
      expect(onsetsFromDurations(measures)).toEqual([...pat.onsetsBeats]);
    },
  );

  it("gives up on a gap with no single written value", () => {
    expect(rhythmStaff({ bars: 1, onsetsBeats: [0, 2.5] })).toBeUndefined();
  });

  it("gives up when a note would cross a barline", () => {
    expect(rhythmStaff({ bars: 2, onsetsBeats: [0, 3.5, 5] })).toBeUndefined();
  });
});

describe("rhythmEcho staff", () => {
  it("carries a staff beside the audio and no reading display", () => {
    const inst = rhythmEcho.generate(
      node,
      { pattern: "r06" },
      {
        rng: createRng(1),
        voiceRange: { low: 48, high: 72 },
        mode: "instrument",
      },
    );
    expect(inst.staff).toBeDefined();
    expect(inst.display).toBeUndefined();
    expect(inst.stimulus.events.some((e) => e.role === "target")).toBe(true);
  });
});
