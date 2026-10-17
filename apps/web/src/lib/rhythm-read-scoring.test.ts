import { createRng, rhythmRead, type NoteEvent, type SkillNode } from "@clavis/core";
import { scoreRhythm } from "@clavis/scoring";
import { describe, expect, it } from "vitest";

// Integration test: core cannot import scoring and scoring may only import core types, so the web
// app, which depends on both, checks that every rhythmRead item scores 1.0 against its own onsets.
const node: SkillNode = {
  id: "read.rhythm.basic",
  strand: "READ",
  title: "Basic rhythm reading",
  prerequisites: [],
  itemGenerators: ["rhythmRead"],
  params: { values: ["quarter", "eighth", "dotted-quarter", "tie"], pitches: 1 },
  mastery: { minAccuracy: 0.9, windowAttempts: 15, distinctSessions: 2 },
  keyDependent: false,
};

describe("rhythmRead against scoreRhythm", () => {
  it("scores every pattern correct with partial 1 on its own ideal onsets, on any key", () => {
    const items = rhythmRead.listItems(node);
    expect(items.length).toBeGreaterThan(0);
    for (const params of items) {
      const inst = rhythmRead.generate(node, params, {
        rng: createRng(7),
        mode: "instrument",
      });
      const play = inst.expected.play;
      if (play?.kind !== "rhythm") throw new Error("expected a rhythm target");
      const beatMs = 60000 / play.tempoBpm;
      const notes: NoteEvent[] = play.onsetsBeats.map((b) => ({
        pitch: 36 + (Math.round(b * 2) % 7), // varying keys: pitch must not matter
        onsetMs: 1000 + 700 + b * beatMs,
        confidence: 1,
        source: "midi",
      }));
      const r = scoreRhythm({
        onsetsBeats: play.onsetsBeats,
        tempoBpm: play.tempoBpm,
        notes,
        stimulusEndMs: 1000,
        responseWindowMs: inst.expected.responseWindowMs,
        source: "midi",
      });
      expect(r.outcome.correct, inst.itemId).toBe(true);
      expect(r.outcome.partial, inst.itemId).toBe(1);
      expect(r.errors, inst.itemId).toEqual([]);
    }
  });
});
