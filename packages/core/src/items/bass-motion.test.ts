import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { SkillNode } from "../graph/schema.js";
import { createRng } from "../random.js";
import { ALL_KEYS, type Key } from "../theory/keys.js";
import { at } from "../theory/util.js";
import { BASS_MOTION_LENGTH, bassMotion, enumerateBassMotions } from "./bass-motion.js";
import { ExpectedResponseSchema } from "./expected.js";
import type { GenerateContext } from "./types.js";

const node = (chords: string[]): SkillNode => ({
  id: "ear.bass.I-IV-V-vi",
  strand: "EAR",
  title: "Bass motion",
  prerequisites: [],
  itemGenerators: ["bassMotion"],
  params: { mode: "major", chords },
  mastery: { minAccuracy: 0.9, windowAttempts: 20, distinctSessions: 2 },
  keyDependent: false,
  targetLatencyMs: 4000,
});
const NODE = node(["I", "IV", "V", "vi"]);
const MAJOR_KEYS = ALL_KEYS.filter((k) => k.mode === "major");

const ctx = (seed: number, extra: Partial<GenerateContext> = {}): GenerateContext => ({
  rng: createRng(seed),
  voiceRange: { low: 48, high: 72 },
  mode: "instrument",
  ...extra,
});

describe("enumerateBassMotions", () => {
  it("lists 27 progressions from I, IV, V and vi, each four long, starting on I", () => {
    const all = enumerateBassMotions(["I", "IV", "V", "vi"]);
    expect(all).toHaveLength(27);
    expect(new Set(all.map((p) => p.join("-"))).size).toBe(27);
    for (const p of all) {
      expect(p).toHaveLength(BASS_MOTION_LENGTH);
      expect(p[0]).toBe("I");
      p.forEach((c, i) => {
        if (i > 0) expect(c).not.toBe(p[i - 1]);
      });
    }
  });

  it("is stable and depth first", () => {
    const all = enumerateBassMotions(["I", "IV", "V", "vi"]);
    expect(all.slice(0, 3).map((p) => p.join(" "))).toEqual(["I IV I IV", "I IV I V", "I IV I vi"]);
    expect(enumerateBassMotions(["I", "IV", "V", "vi"])).toEqual(all);
  });

  it("shrinks with a smaller chord set, and is empty without I", () => {
    expect(enumerateBassMotions(["I", "IV", "V"])).toHaveLength(8);
    expect(enumerateBassMotions(["IV", "V", "vi"])).toEqual([]);
  });
});

describe("bassMotion generator", () => {
  it("lists the node's universe as prog params", () => {
    const items = bassMotion.listItems(NODE);
    expect(items).toHaveLength(27);
    expect(items[0]).toEqual({ prog: ["I", "IV", "I", "IV"] });
  });

  it("builds the item id from the progression only, never the key", () => {
    const params = { prog: ["I", "vi", "IV", "V"] };
    const a = bassMotion.generate(NODE, params, ctx(1));
    const b = bassMotion.generate(NODE, params, ctx(2));
    expect(a.itemId).toBe("ear.bass.I-IV-V-vi|prog=I-vi-IV-V");
    expect(b.itemId).toBe(a.itemId);
  });

  // Table: key, progression, expected bass pitch classes (C = 0).
  it.each([
    ["C", ["I", "IV", "V", "vi"], [0, 5, 7, 9]],
    ["G", ["I", "vi", "IV", "V"], [7, 4, 0, 2]],
    ["Bb", ["I", "V", "vi", "IV"], [10, 5, 7, 3]],
    ["F#", ["I", "IV", "I", "V"], [6, 11, 6, 1]],
  ] as const)("in %s major %j expects roots %j", (tonic, prog, roots) => {
    const inst = bassMotion.generate(
      NODE,
      { prog: [...prog] },
      ctx(3, {
        preferredKey: { tonic, mode: "major" },
      }),
    );
    const play = inst.expected.play;
    if (play?.kind !== "sequence") throw new Error("expected a sequence target");
    expect(play.octaveAgnostic).toBe(true);
    expect(play.midi.map((m) => m % 12)).toEqual(roots);
    // The stimulus bass notes are the same roots.
    const heard = inst.stimulus.events.filter((e) => e.role === "target");
    expect(heard.map((e) => at(e.midi, 0) % 12)).toEqual(roots);
  });

  it("plays the cadence, a gap, then one four-note chord per beat", () => {
    const inst = bassMotion.generate(NODE, { prog: ["I", "IV", "V", "vi"] }, ctx(4));
    const ev = inst.stimulus.events;
    expect(ev.slice(0, 4).every((e) => e.role === "cadence")).toBe(true);
    const heard = ev.slice(4);
    expect(heard).toHaveLength(4);
    expect(heard.every((e) => e.role === "target" && e.midi.length === 4)).toBe(true);
    const beat = 60 / (inst.stimulus.tempoBpm ?? 90);
    heard.forEach((e, i) => {
      if (i > 0) expect(e.atSec - at(heard, i - 1).atSec).toBeCloseTo(beat, 6);
    });
    expect(at(heard, 0).atSec).toBeGreaterThan(at(ev, 3).atSec + at(ev, 3).durationSec);
  });

  it("keeps expected notes inside the keyboard range, in its lowest octave", () => {
    const keyboardRange = { low: 48, high: 84 };
    for (const key of MAJOR_KEYS) {
      for (const params of bassMotion.listItems(NODE)) {
        const inst = bassMotion.generate(
          NODE,
          params,
          ctx(5, { preferredKey: key, keyboardRange }),
        );
        const play = inst.expected.play;
        if (play?.kind !== "sequence") throw new Error("expected a sequence target");
        for (const m of play.midi) {
          expect(m).toBeGreaterThanOrEqual(48);
          expect(m).toBeLessThan(60);
        }
      }
    }
  });

  it("respects a custom keyboard range", () => {
    const inst = bassMotion.generate(
      NODE,
      { prog: ["I", "IV", "V", "vi"] },
      ctx(6, {
        keyboardRange: { low: 36, high: 72 },
      }),
    );
    const play = inst.expected.play;
    if (play?.kind !== "sequence") throw new Error("expected a sequence target");
    for (const m of play.midi) expect(m >= 36 && m < 48).toBe(true);
  });

  it("carries latency, a window and a replayable presentation", () => {
    const inst = bassMotion.generate(NODE, { prog: ["I", "V", "vi", "IV"] }, ctx(7));
    expect(inst.targetLatencyMs).toBe(4000);
    expect(inst.expected.sing).toBeUndefined();
    expect(inst.expected.responseWindowMs).toBe(12000);
    expect(inst.presentation).toMatchObject({
      mode: "major",
      prog: ["I", "V", "vi", "IV"],
    });
    expect((inst.presentation.bassMidi as number[]).map((m) => m % 12)).toEqual(
      (inst.expected.play as { midi: number[] }).midi.map((m) => m % 12),
    );
  });

  it("uses the preferred key when it is major, and a major key otherwise", () => {
    const pref: Key = { tonic: "Eb", mode: "major" };
    expect(
      bassMotion.generate(NODE, { prog: ["I", "IV", "V", "vi"] }, ctx(8, { preferredKey: pref }))
        .presentation.tonic,
    ).toBe("Eb");
    const minor = bassMotion.generate(
      NODE,
      { prog: ["I", "IV", "V", "vi"] },
      ctx(8, {
        preferredKey: { tonic: "A", mode: "minor" },
      }),
    );
    expect(minor.presentation.mode).toBe("major");
  });

  it("is deterministic for a seed", () => {
    const params = { prog: ["I", "vi", "V", "IV"] };
    expect(bassMotion.generate(NODE, params, ctx(9))).toEqual(
      bassMotion.generate(NODE, params, ctx(9)),
    );
  });

  it("rejects progressions outside the node's chords or of the wrong length", () => {
    const small = node(["I", "IV", "V"]);
    expect(() => bassMotion.generate(small, { prog: ["I", "IV", "V", "vi"] }, ctx(1))).toThrow(
      RangeError,
    );
    expect(() => bassMotion.generate(NODE, { prog: ["I", "IV", "V"] }, ctx(1))).toThrow();
    expect(() => bassMotion.generate(NODE, { prog: ["I", "IV", "V", "bII"] }, ctx(1))).toThrow();
  });

  it("property: every item validates in every major key for any seed", () => {
    const items = bassMotion.listItems(NODE);
    fc.assert(
      fc.property(
        fc.nat(0x7fffffff),
        fc.nat(items.length - 1),
        fc.constantFrom(...MAJOR_KEYS),
        (seed, idx, preferredKey) => {
          const inst = bassMotion.generate(NODE, at(items, idx), ctx(seed, { preferredKey }));
          expect(ExpectedResponseSchema.safeParse(inst.expected).success).toBe(true);
          const play = inst.expected.play;
          if (play?.kind !== "sequence") throw new Error("expected a sequence target");
          expect(play.midi).toHaveLength(BASS_MOTION_LENGTH);
          expect(play.degreeLabels).toHaveLength(12);
        },
      ),
      { numRuns: 150 },
    );
  });
});
