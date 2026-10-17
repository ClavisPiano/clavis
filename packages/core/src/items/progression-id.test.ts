import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { SkillNode } from "../graph/schema.js";
import { createRng } from "../random.js";
import { romanChord } from "../theory/cadence.js";
import { ALL_KEYS, type Key } from "../theory/keys.js";
import { at } from "../theory/util.js";
import { ExpectedResponseSchema } from "./expected.js";
import {
  CADENCE_LEAD_IN,
  PROGRESSION_ID_WINDOW_MS,
  cadenceLabel,
  progressionId,
  progressionLabel,
} from "./progression-id.js";
import type { GenerateContext } from "./types.js";

const make = (id: string, params: SkillNode["params"]): SkillNode => ({
  id,
  strand: "EAR",
  title: id,
  prerequisites: [],
  itemGenerators: ["progressionId"],
  params,
  mastery: { minAccuracy: 0.9, windowAttempts: 20, distinctSessions: 2 },
  keyDependent: false,
  targetLatencyMs: 3000,
});

const CORE = make("ear.prog.core", {
  mode: "major",
  progressions: [
    ["I", "V", "vi", "IV"],
    ["I", "IV", "V"],
    ["ii", "V", "I"],
    ["vi", "IV", "I", "V"],
  ],
});
const CADENCE = make("ear.cadence", {
  mode: "major",
  cadences: {
    perfect: ["V", "I"],
    plagal: ["IV", "I"],
    imperfect: ["I", "V"],
    deceptive: ["V", "vi"],
  },
});
const MINOR = make("ear.prog.minor", {
  mode: "minor",
  progressions: [
    ["i", "iv", "v"],
    ["i", "VI", "III", "VII"],
    ["i", "VII", "VI", "V"],
  ],
});
const COLOUR = make("ear.prog.colour", {
  mode: "major",
  progressions: [
    ["I", "V/V", "V", "I"],
    ["I", "IV", "iv", "I"],
    ["I", "bVII", "IV", "I"],
  ],
});
const NODES = [CORE, CADENCE, MINOR, COLOUR];
const CADENCE_PAIRS: Record<string, string[]> = {
  perfect: ["V", "I"],
  plagal: ["IV", "I"],
  imperfect: ["I", "V"],
  deceptive: ["V", "vi"],
};

const ctx = (seed: number, extra: Partial<GenerateContext> = {}): GenerateContext => ({
  rng: createRng(seed),
  mode: "instrument",
  ...extra,
});

const choiceOf = (inst: ReturnType<typeof progressionId.generate>) => {
  const play = inst.expected.play;
  if (play?.kind !== "choice") throw new Error("expected a choice target");
  return play;
};
const sortedPcs = (xs: readonly number[]): number[] => [...new Set(xs)].sort((a, b) => a - b);

/** Check one chord's midi notes against the Roman numeral in the key: root in the bass, same notes. */
function expectChord(midi: readonly number[], key: Key, roman: string): void {
  expect(midi).toHaveLength(4);
  const triad = romanChord(key, roman);
  expect(at(midi, 0) % 12).toBe(triad[0]);
  expect(sortedPcs(midi.map((m) => m % 12))).toEqual(sortedPcs(triad));
}

describe("progressionId universe", () => {
  it.each([
    [CORE, 4],
    [CADENCE, 4],
    [MINOR, 3],
    [COLOUR, 3],
  ])("%j has the expected number of items", (node, size) => {
    const items = progressionId.listItems(node);
    expect(items).toHaveLength(size);
    expect(new Set(items.map((i) => JSON.stringify(i))).size).toBe(size);
  });

  it("lists progressions in node order and cadences by name", () => {
    expect(progressionId.listItems(CORE)[0]).toEqual({ prog: ["I", "V", "vi", "IV"] });
    expect(progressionId.listItems(CADENCE).map((p) => p.cadence)).toEqual([
      "perfect",
      "plagal",
      "imperfect",
      "deceptive",
    ]);
  });

  it("rejects bad node params", () => {
    const bad = [
      { mode: "major" },
      { mode: "major", progressions: [["I", "V"]], cadences: { a: ["V", "I"] } },
      {
        mode: "major",
        progressions: [
          ["I", "i"],
          ["I", "V"],
        ],
      },
      { mode: "minor", cadences: { a: ["V", "i"], b: ["iv", "i"] } },
      { mode: "major", cadences: { a: ["V", "I", "I"] } },
    ];
    for (const params of bad) {
      expect(() => progressionId.listItems(make("n", params))).toThrow();
    }
  });
});

describe("progressionId generator", () => {
  it("builds ids from the progression or cadence, never the key", () => {
    const prog = { prog: ["I", "V", "vi", "IV"] };
    const a = progressionId.generate(CORE, prog, ctx(1));
    const b = progressionId.generate(CORE, prog, ctx(2));
    expect(a.itemId).toBe("ear.prog.core|prog=I-V-vi-IV");
    expect(b.itemId).toBe(a.itemId);
    expect(progressionId.generate(CADENCE, { cadence: "plagal" }, ctx(3)).itemId).toBe(
      "ear.cadence|cadence=plagal",
    );
    expect(progressionId.generate(COLOUR, { prog: ["I", "V/V", "V", "I"] }, ctx(3)).itemId).toBe(
      "ear.prog.colour|prog=I-V/V-V-I",
    );
  });

  it("ids are the same across every key of the mode", () => {
    for (const node of NODES) {
      const mode = (node.params as { mode: Key["mode"] }).mode;
      for (const params of progressionId.listItems(node)) {
        const ids = new Set(
          ALL_KEYS.filter((k) => k.mode === mode).map(
            (preferredKey) => progressionId.generate(node, params, ctx(4, { preferredKey })).itemId,
          ),
        );
        expect(ids.size).toBe(1);
      }
    }
  });

  // Table over every progression item of every node and every key: the heard chords are the
  // numerals, in order, after the cadence context.
  it("plays the chosen progression's chords after the key-setting cadence", () => {
    for (const node of [CORE, MINOR, COLOUR]) {
      const mode = (node.params as { mode: Key["mode"] }).mode;
      for (const params of progressionId.listItems(node)) {
        for (const preferredKey of ALL_KEYS.filter((k) => k.mode === mode)) {
          const inst = progressionId.generate(node, params, ctx(5, { preferredKey }));
          const romans = params.prog as string[];
          const ev = inst.stimulus.events;
          const cad = ev.filter((e) => e.role === "cadence");
          const heard = ev.filter((e) => e.role === "target");
          // I-IV-V-I (i-iv-V-i in minor) sets the key.
          expect(cad).toHaveLength(4);
          expectChord(at(cad, 0).midi, preferredKey, mode === "major" ? "I" : "i");
          expectChord(at(cad, 2).midi, preferredKey, "V");
          expect(heard).toHaveLength(romans.length);
          heard.forEach((e, i) => {
            expectChord(e.midi, preferredKey, at(romans, i));
          });
          expect(inst.presentation.romans).toEqual(romans);
          expect(inst.presentation.chordMidi).toEqual(heard.map((e) => e.midi));
          // The cadence ends before the first heard chord, with a gap.
          expect(at(heard, 0).atSec).toBeGreaterThan(at(cad, 3).atSec + at(cad, 3).durationSec);
        }
      }
    }
  });

  it("plays a short I-ii lead-in and then the cadence pair", () => {
    for (const params of progressionId.listItems(CADENCE)) {
      for (const preferredKey of ALL_KEYS.filter((k) => k.mode === "major")) {
        const inst = progressionId.generate(CADENCE, params, ctx(6, { preferredKey }));
        const name = params.cadence;
        const pair = typeof name === "string" ? (CADENCE_PAIRS[name] ?? []) : [];
        const ev = inst.stimulus.events;
        const lead = ev.filter((e) => e.role === "cadence");
        const heard = ev.filter((e) => e.role === "target");
        expect(lead).toHaveLength(CADENCE_LEAD_IN.length);
        lead.forEach((e, i) => {
          expectChord(e.midi, preferredKey, at(CADENCE_LEAD_IN, i));
        });
        expect(heard).toHaveLength(2);
        heard.forEach((e, i) => {
          expectChord(e.midi, preferredKey, at(pair, i));
        });
        // The lead-in sounds first, then a gap, then the pair, the last chord held longest.
        expect(at(heard, 0).atSec).toBeGreaterThan(at(lead, 1).atSec + at(lead, 1).durationSec);
        expect(at(heard, 1).durationSec).toBeGreaterThan(at(heard, 0).durationSec);
      }
    }
  });

  it("voices chords with smooth voice leading", () => {
    for (const node of NODES) {
      const mode = (node.params as { mode: Key["mode"] }).mode;
      for (const params of progressionId.listItems(node)) {
        for (const preferredKey of ALL_KEYS.filter((k) => k.mode === mode)) {
          const heard = progressionId
            .generate(node, params, ctx(7, { preferredKey }))
            .stimulus.events.filter((e) => e.role === "target");
          heard.forEach((e, i) => {
            const prev = heard[i - 1];
            if (!prev) return;
            e.midi.slice(1).forEach((n, v) => {
              expect(Math.abs(n - (prev.midi[v + 1] ?? 0))).toBeLessThanOrEqual(5);
            });
          });
        }
      }
    }
  });

  it("offers the node's options as buttons, in order, with the right one correct", () => {
    const inst = progressionId.generate(CORE, { prog: ["ii", "V", "I"] }, ctx(1));
    const choice = choiceOf(inst);
    expect(choice.options.map((o) => o.label)).toEqual([
      "I-V-vi-IV",
      "I-IV-V",
      "ii-V-I",
      "vi-IV-I-V",
    ]);
    expect(choice.correct).toBe("ii-V-I");
    expect(progressionLabel(["I", "IV", "V"])).toBe("I-IV-V");

    const cad = choiceOf(progressionId.generate(CADENCE, { cadence: "deceptive" }, ctx(1)));
    expect(cad.options.map((o) => o.label)).toEqual([
      "Perfect",
      "Plagal",
      "Imperfect",
      "Deceptive",
    ]);
    expect(cad.correct).toBe("deceptive");
    expect(cadenceLabel("plagal")).toBe("Plagal");
  });

  it("works in Away mode: the same choice target, no sung part", () => {
    const inst = progressionId.generate(CORE, { prog: ["I", "IV", "V"] }, ctx(1, { mode: "away" }));
    expect(choiceOf(inst).correct).toBe("I-IV-V");
    expect(inst.expected.sing).toBeUndefined();
  });

  it("carries latency, a window and a replayable presentation", () => {
    const inst = progressionId.generate(MINOR, { prog: ["i", "iv", "v"] }, ctx(2));
    expect(inst.targetLatencyMs).toBe(3000);
    expect(inst.expected.responseWindowMs).toBe(PROGRESSION_ID_WINDOW_MS);
    expect(inst.presentation).toMatchObject({ mode: "minor", option: "i-iv-v" });
    expect(inst.presentation.seed).toEqual(expect.any(Number));
  });

  it("uses a preferred key of the node's mode, else a random one of that mode", () => {
    const eb = progressionId.generate(
      CORE,
      { prog: ["I", "IV", "V"] },
      ctx(7, { preferredKey: { tonic: "Eb", mode: "major" } }),
    );
    expect(eb.presentation.tonic).toBe("Eb");
    const fromMinor = progressionId.generate(
      CORE,
      { prog: ["I", "IV", "V"] },
      ctx(7, { preferredKey: { tonic: "A", mode: "minor" } }),
    );
    expect(fromMinor.presentation.mode).toBe("major");
  });

  it("is deterministic for a seed", () => {
    for (const node of NODES) {
      const params = at(progressionId.listItems(node), 1);
      expect(progressionId.generate(node, params, ctx(9))).toEqual(
        progressionId.generate(node, params, ctx(9)),
      );
    }
  });

  it("rejects items outside the node and malformed params", () => {
    expect(() => progressionId.generate(CORE, { prog: ["I", "V"] }, ctx(1))).toThrow(RangeError);
    expect(() => progressionId.generate(CADENCE, { cadence: "half" }, ctx(1))).toThrow(RangeError);
    expect(() => progressionId.generate(CORE, { cadence: "perfect" }, ctx(1))).toThrow(RangeError);
    expect(() => progressionId.generate(CORE, { degree: 1 }, ctx(1))).toThrow();
  });

  it("property: every item validates for any seed and key", () => {
    const all = NODES.flatMap((node) =>
      progressionId.listItems(node).map((params) => ({ node, params })),
    );
    fc.assert(
      fc.property(fc.nat(0x7fffffff), fc.nat(all.length - 1), (seed, idx) => {
        const { node, params } = at(all, idx);
        const inst = progressionId.generate(node, params, ctx(seed));
        expect(ExpectedResponseSchema.safeParse(inst.expected).success).toBe(true);
        const correct = choiceOf(inst).correct;
        expect(choiceOf(inst).options.some((o) => o.id === correct)).toBe(true);
        expect(inst.itemId.startsWith(`${node.id}|`)).toBe(true);
      }),
      { numRuns: 120 },
    );
  });
});
