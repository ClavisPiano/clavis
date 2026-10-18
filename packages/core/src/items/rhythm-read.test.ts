import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { SkillNode } from "../graph/schema.js";
import { createRng } from "../random.js";
import { ScoreSpecSchema, scoreNoteIds } from "../score/schema.js";
import { StimulusSpecSchema } from "../stimulus/types.js";
import { ExpectedResponseSchema } from "./expected.js";
import { COUNT_IN_PITCH, COUNT_IN_VELOCITY } from "./rhythm.js";
import {
  READ_RHYTHMS,
  durationBeats,
  onsetsFromDurations,
  rhythmRead,
  type ReadRhythm,
} from "./rhythm-read.js";
import type { GenerateContext, ItemParams } from "./types.js";

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

const ctx = (seed: number): GenerateContext => ({
  rng: createRng(seed),
  mode: "instrument",
});

const byId = (id: string): ReadRhythm => {
  const p = READ_RHYTHMS.find((r) => r.id === id);
  if (p === undefined) throw new Error(id);
  return p;
};

const patternOf = (p: ItemParams): string => z.string().parse(p.pattern);
const noteCount = (r: ReadRhythm): number => r.measures.reduce((s, b) => s + b.length, 0);

describe("READ_RHYTHMS", () => {
  it("has unique ids and fills every bar with exactly 4 beats", () => {
    expect(new Set(READ_RHYTHMS.map((r) => r.id)).size).toBe(READ_RHYTHMS.length);
    for (const r of READ_RHYTHMS) {
      expect(r.measures).toHaveLength(r.bars);
      for (const bar of r.measures)
        expect(
          bar.reduce((s, d) => s + durationBeats(d), 0),
          r.id,
        ).toBe(4);
    }
  });

  it("derives onsets that match a hand-written table", () => {
    const table: Record<string, number[]> = {
      rr01: [0, 1, 2, 3],
      rr04: [0, 1, 1.5, 2, 3],
      rr08: [0, 1.5, 2, 3],
      rr10: [0, 1.5, 2, 3.5],
      rr15: [0, 0.5, 1.5, 2.5, 3.5],
      rr22: [0, 0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 7],
    };
    for (const [id, onsets] of Object.entries(table))
      expect(byId(id).onsetsBeats, id).toEqual(onsets);
  });

  it("removes exactly one onset per tie", () => {
    expect(byId("rr11").onsetsBeats).toEqual([0, 1, 3]);
    expect(noteCount(byId("rr11")) - byId("rr11").onsetsBeats.length).toBe(1);
    expect(byId("rr12").onsetsBeats).toEqual([0, 1, 2, 3, 5, 6, 7]);
    expect(noteCount(byId("rr12")) - byId("rr12").onsetsBeats.length).toBe(1);
    for (const r of READ_RHYTHMS) {
      const ties = r.measures.flat().filter((d) => d.tie === "stop" || d.tie === "continue").length;
      expect(noteCount(r) - r.onsetsBeats.length, r.id).toBe(ties);
      expect(r.onsetsBeats).toEqual(onsetsFromDurations(r.measures));
    }
  });

  it("marks tie roles consistently (every start is followed by a stop)", () => {
    for (const r of READ_RHYTHMS) {
      let open = false;
      for (const d of r.measures.flat()) {
        expect(open === (d.tie === "stop" || d.tie === "continue"), r.id).toBe(true);
        open = d.tie === "start" || d.tie === "continue";
      }
      expect(open).toBe(false);
    }
  });
});

describe("rhythmRead", () => {
  it("lists only patterns allowed by the node values (no half notes)", () => {
    const ids = rhythmRead.listItems(node).map((p) => p.pattern);
    expect(ids).not.toContain("rr02");
    expect(ids).not.toContain("rr23");
    expect(ids).toContain("rr12");
    expect(ids.length).toBeGreaterThanOrEqual(15);
    expect(rhythmRead.listItems({ ...node, params: {} })).toHaveLength(READ_RHYTHMS.length);
    const oneBar = rhythmRead.listItems({ ...node, params: { bars: [1] } });
    expect(oneBar.every((p) => byId(patternOf(p)).bars === 1)).toBe(true);
  });

  it("generates valid display, count-in only stimulus and a pitchless rhythm target", () => {
    for (const params of rhythmRead.listItems(node)) {
      const inst = rhythmRead.generate(node, params, ctx(3));
      const pat = byId(patternOf(params));
      expect(inst.itemId).toBe(`read.rhythm.basic|pattern=${pat.id}`);
      expect(inst.generator).toBe("rhythmRead");

      const display = ScoreSpecSchema.parse(inst.display);
      expect(scoreNoteIds(display)).toEqual(
        Array.from({ length: noteCount(pat) }, (_, i) => "n" + String(i + 1)),
      );
      expect(display.staves[0]?.clef).toBe("percussion");
      expect(display.staves[0]?.lines).toBe(1);
      expect(display.key).toBeNull();
      expect(display.meter).toEqual({ beats: 4, beatValue: 4 });

      const stim = StimulusSpecSchema.parse(inst.stimulus);
      expect(stim.events).toHaveLength(4);
      for (const e of stim.events) {
        expect(e.role).toBe("count-in");
        expect(e.midi).toEqual([COUNT_IN_PITCH]);
        expect(e.velocity).toBe(COUNT_IN_VELOCITY);
      }

      const expected = ExpectedResponseSchema.parse(inst.expected);
      expect(expected.play).toEqual({
        kind: "rhythm",
        onsetsBeats: [...pat.onsetsBeats],
        tempoBpm: inst.presentation.tempoBpm,
        beatsPerBar: 4,
      });
      expect(inst.presentation.pattern).toBe(pat.id);
      expect(typeof inst.presentation.seed).toBe("number");
    }
  });

  it("picks tempo in 5 bpm steps within 60-80 and is deterministic per seed", () => {
    const seen = new Set<number>();
    for (let seed = 0; seed < 60; seed++) {
      const a = rhythmRead.generate(node, { pattern: "rr08" }, ctx(seed));
      const b = rhythmRead.generate(node, { pattern: "rr08" }, ctx(seed));
      expect(a).toEqual(b);
      const bpm = a.presentation.tempoBpm as number;
      expect(bpm % 5).toBe(0);
      expect(bpm).toBeGreaterThanOrEqual(60);
      expect(bpm).toBeLessThanOrEqual(80);
      seen.add(bpm);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("rejects unknown or filtered patterns", () => {
    expect(() => rhythmRead.generate(node, { pattern: "zz" }, ctx(1))).toThrow(RangeError);
    expect(() => rhythmRead.generate(node, { pattern: "rr02" }, ctx(1))).toThrow(RangeError);
  });
});
