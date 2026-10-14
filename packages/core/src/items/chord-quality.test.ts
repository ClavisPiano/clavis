import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { SkillNode } from "../graph/schema.js";
import { createRng } from "../random.js";
import { ALL_KEYS, tonicChroma } from "../theory/keys.js";
import { at } from "../theory/util.js";
import { CHORD_QUALITY_WINDOW_MS, chordQuality } from "./chord-quality.js";
import { ExpectedResponseSchema } from "./expected.js";
import type { GenerateContext } from "./types.js";

const node = (qualities: string[], roots = [1, 2, 3, 4, 5, 6]): SkillNode => ({
  id: "ear.quality.triad",
  strand: "EAR",
  title: "Triad quality",
  prerequisites: [],
  itemGenerators: ["chordQuality"],
  params: { qualities, roots },
  mastery: { minAccuracy: 0.9, windowAttempts: 20, distinctSessions: 2 },
  keyDependent: false,
  targetLatencyMs: 2000,
});
const NODE = node(["major", "minor"]);
const MAJOR_KEYS = ALL_KEYS.filter((k) => k.mode === "major");

const ctx = (seed: number, extra: Partial<GenerateContext> = {}): GenerateContext => ({
  rng: createRng(seed),
  voiceRange: { low: 48, high: 72 },
  mode: "instrument",
  ...extra,
});

const choiceOf = (inst: ReturnType<typeof chordQuality.generate>) => {
  const play = inst.expected.play;
  if (play?.kind !== "choice") throw new Error("expected a choice target");
  return play;
};

describe("chordQuality universe", () => {
  it("is every quality on every root, quality first, 12 items for major and minor", () => {
    const items = chordQuality.listItems(NODE);
    expect(items).toHaveLength(12);
    expect(items[0]).toEqual({ quality: "major", root: 1 });
    expect(items[6]).toEqual({ quality: "minor", root: 1 });
    expect(new Set(items.map((i) => JSON.stringify(i))).size).toBe(12);
  });

  it("grows with diminished and shrinks with fewer roots", () => {
    expect(chordQuality.listItems(node(["major", "minor", "diminished"]))).toHaveLength(18);
    expect(chordQuality.listItems(node(["major", "minor"], [1, 4, 5]))).toHaveLength(6);
  });
});

describe("chordQuality generator", () => {
  it("builds the id from quality and root, never the key", () => {
    const params = { quality: "minor", root: 4 };
    const a = chordQuality.generate(NODE, params, ctx(1));
    const b = chordQuality.generate(NODE, params, ctx(2));
    expect(a.itemId).toBe("ear.quality.triad|quality=minor|root=4");
    expect(b.itemId).toBe(a.itemId);
  });

  // Table: quality, expected intervals above the chord root.
  it.each([
    ["major", [0, 4, 7]],
    ["minor", [0, 3, 7]],
    ["diminished", [0, 3, 6]],
  ] as const)("a %s triad has intervals %j", (quality, intervals) => {
    const n = node(["major", "minor", "diminished"]);
    for (const key of MAJOR_KEYS) {
      const inst = chordQuality.generate(n, { quality, root: 3 }, ctx(5, { preferredKey: key }));
      const chord = inst.presentation.chordMidi as number[];
      expect(chord).toHaveLength(4);
      const rootMidi = at(chord, 1);
      expect(chord.slice(1).map((m) => m - rootMidi)).toEqual(intervals);
      expect(at(chord, 0) % 12).toBe(rootMidi % 12);
      expect(at(chord, 0)).toBeLessThan(rootMidi);
      // Root is the third degree of the key's major scale.
      expect(rootMidi % 12).toBe((tonicChroma(key) + 4) % 12);
    }
  });

  it("offers the node's qualities as buttons in order, with the right one correct", () => {
    const inst = chordQuality.generate(NODE, { quality: "minor", root: 2 }, ctx(3));
    const choice = choiceOf(inst);
    expect(choice.options).toEqual([
      { id: "major", label: "Major" },
      { id: "minor", label: "Minor" },
    ]);
    expect(choice.correct).toBe("minor");
    const three = chordQuality.generate(
      node(["major", "minor", "diminished"]),
      { quality: "diminished", root: 2 },
      ctx(3),
    );
    expect(choiceOf(three).options.map((o) => o.label)).toEqual(["Major", "Minor", "Diminished"]);
  });

  it("plays the cadence, a gap, then one chord held for two beats", () => {
    const inst = chordQuality.generate(NODE, { quality: "major", root: 1 }, ctx(4));
    const ev = inst.stimulus.events;
    expect(ev.slice(0, 4).every((e) => e.role === "cadence")).toBe(true);
    expect(ev).toHaveLength(5);
    const chord = at(ev, 4);
    const beat = 60 / (inst.stimulus.tempoBpm ?? 90);
    expect(chord.role).toBe("target");
    expect(chord.durationSec).toBeCloseTo(2 * beat, 6);
    expect(chord.atSec).toBeGreaterThan(at(ev, 3).atSec + at(ev, 3).durationSec);
  });

  it("carries latency, a window, no sung part and a replayable presentation", () => {
    const inst = chordQuality.generate(NODE, { quality: "major", root: 5 }, ctx(6));
    expect(inst.targetLatencyMs).toBe(2000);
    expect(inst.expected.sing).toBeUndefined();
    expect(inst.expected.responseWindowMs).toBe(CHORD_QUALITY_WINDOW_MS);
    expect(inst.presentation).toMatchObject({ mode: "major", quality: "major", root: 5 });
  });

  it("uses a preferred major key, and a major key when the preferred one is minor", () => {
    const eb = chordQuality.generate(
      NODE,
      { quality: "major", root: 1 },
      ctx(7, { preferredKey: { tonic: "Eb", mode: "major" } }),
    );
    expect(eb.presentation.tonic).toBe("Eb");
    const minor = chordQuality.generate(
      NODE,
      { quality: "major", root: 1 },
      ctx(7, { preferredKey: { tonic: "A", mode: "minor" } }),
    );
    expect(minor.presentation.mode).toBe("major");
  });

  it("is deterministic for a seed", () => {
    const params = { quality: "minor", root: 6 };
    expect(chordQuality.generate(NODE, params, ctx(9))).toEqual(
      chordQuality.generate(NODE, params, ctx(9)),
    );
  });

  it("rejects items outside the node and malformed params", () => {
    expect(() => chordQuality.generate(NODE, { quality: "diminished", root: 1 }, ctx(1))).toThrow(
      RangeError,
    );
    expect(() => chordQuality.generate(NODE, { quality: "major", root: 7 }, ctx(1))).toThrow(
      RangeError,
    );
    expect(() => chordQuality.generate(NODE, { quality: "augmented", root: 1 }, ctx(1))).toThrow();
  });

  it("property: every item validates in every major key for any seed", () => {
    const items = chordQuality.listItems(NODE);
    fc.assert(
      fc.property(
        fc.nat(0x7fffffff),
        fc.nat(items.length - 1),
        fc.constantFrom(...MAJOR_KEYS),
        (seed, idx, preferredKey) => {
          const item = at(items, idx);
          const inst = chordQuality.generate(NODE, item, ctx(seed, { preferredKey }));
          expect(ExpectedResponseSchema.safeParse(inst.expected).success).toBe(true);
          expect(choiceOf(inst).correct).toBe(item.quality);
        },
      ),
      { numRuns: 150 },
    );
  });
});
