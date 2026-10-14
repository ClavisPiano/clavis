import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { JsonObjectSchema } from "../json.js";
import { createRng } from "../random.js";
import type { SkillNode } from "../graph/schema.js";
import { at } from "../theory/util.js";
import { cadence } from "../theory/cadence.js";
import { degreeToMidi } from "../theory/degrees.js";
import { ALL_KEYS, tonicChroma, type Key, type VoiceRange } from "../theory/keys.js";
import { ExpectedResponseSchema } from "./expected.js";
import { degreeLabels } from "./build.js";
import { enumerateCells } from "./cell.js";
import { itemId } from "./ids.js";
import { GENERATORS, getGenerator } from "./registry.js";
import { StimulusSpecSchema } from "../stimulus/types.js";
import type { GenerateContext } from "./types.js";

const mastery = { minAccuracy: 0.9, windowAttempts: 20, distinctSessions: 2 };
const base = {
  strand: "EAR" as const,
  title: "t",
  prerequisites: [],
  mastery,
  keyDependent: false,
};
const NODES: SkillNode[] = [
  {
    ...base,
    id: "ear.degrees.major.135",
    itemGenerators: ["degreeSing", "degreeId"],
    params: { mode: "major", degrees: [1, 3, 5] },
    targetLatencyMs: 1500,
  },
  {
    ...base,
    id: "ear.degrees.minor",
    itemGenerators: ["degreeSing", "degreeId"],
    params: { mode: "minor", variants: ["natural", "harmonic"], degrees: [1, 2, 3, 4, 5, 6, 7] },
  },
  {
    ...base,
    id: "ear.cells.major.2-4",
    itemGenerators: ["cellEcho"],
    params: { mode: "major", minNotes: 2, maxNotes: 4, diatonic: true },
  },
  {
    ...base,
    id: "ear.rhythm.echo",
    itemGenerators: ["rhythmEcho"],
    params: { bars: [1, 2], meter: "4/4" },
  },
  {
    ...base,
    id: "ear.quality.triad",
    itemGenerators: ["chordQuality"],
    params: { qualities: ["major", "minor"], roots: [1, 2, 3, 4, 5, 6] },
    targetLatencyMs: 2000,
  },
  {
    ...base,
    id: "ear.bass.I-IV-V-vi",
    itemGenerators: ["bassMotion"],
    params: { mode: "major", chords: ["I", "IV", "V", "vi"] },
    targetLatencyMs: 4000,
  },
];
const nodeFor = (id: string): SkillNode => {
  const n = NODES.find((x) => x.id === id);
  if (n === undefined) throw new Error(id);
  return n;
};

const VOICE: VoiceRange = { low: 48, high: 72 };
const KEYBOARD: VoiceRange = { low: 48, high: 84 };
const ctx = (seed: number, extra: Partial<GenerateContext> = {}): GenerateContext => ({
  rng: createRng(seed),
  voiceRange: VOICE,
  mode: "instrument",
  ...extra,
});

/** All (node, generator, params) triples. */
const ALL = NODES.flatMap((node) =>
  node.itemGenerators.flatMap((g) =>
    getGenerator(g)
      .listItems(node)
      .map((params) => ({ node, g, params })),
  ),
);

describe("itemId", () => {
  it("sorts keys and joins arrays with '-'", () => {
    expect(itemId("ear.degrees.major.135", { degree: 3 })).toBe("ear.degrees.major.135|degree=3");
    expect(itemId("n", { b: 1, a: [1, 2, 3] })).toBe("n|a=1-2-3|b=1");
    expect(itemId("n", { cell: [1, -3] })).toBe("n|cell=1--3");
  });
});

describe("registry and universes", () => {
  it("registers the ear and reading generators", () => {
    expect(Object.keys(GENERATORS).sort()).toEqual(
      [
        "bassMotion",
        "bassNoteRead",
        "cellEcho",
        "chordQuality",
        "degreeId",
        "degreeSing",
        "rhythmEcho",
        "rhythmRead",
      ].sort(),
    );
  });

  it("degreeSing and degreeId share one universe (R14)", () => {
    for (const id of ["ear.degrees.major.135", "ear.degrees.minor"]) {
      const n = nodeFor(id);
      expect(getGenerator("degreeSing").listItems(n)).toEqual(
        getGenerator("degreeId").listItems(n),
      );
    }
    expect(getGenerator("degreeId").listItems(nodeFor("ear.degrees.major.135"))).toEqual([
      { degree: 1 },
      { degree: 3 },
      { degree: 5 },
    ]);
  });

  it("cell universe is a reasonable size, unique, diatonic-range and rule-abiding", () => {
    const cells = enumerateCells(2, 4);
    expect(cells.length).toBeGreaterThanOrEqual(60);
    expect(cells.length).toBeLessThanOrEqual(150);
    expect(new Set(cells.map((c) => c.join("-"))).size).toBe(cells.length);
    for (const c of cells) {
      expect([1, 3, 5]).toContain(c[0]);
      expect(c.length).toBeGreaterThanOrEqual(2);
      expect(c.length).toBeLessThanOrEqual(4);
      for (let i = 1; i < c.length; i++) {
        const move = Math.abs(at(c, i) - at(c, i - 1));
        expect(move).toBeGreaterThanOrEqual(1);
        expect(move).toBeLessThanOrEqual(4);
      }
      for (const d of c) {
        expect(d).toBeGreaterThanOrEqual(-3);
        expect(d).toBeLessThanOrEqual(10);
      }
    }
  });

  it("rhythm universe has ~20 distinct patterns with strictly increasing onsets", () => {
    const items = getGenerator("rhythmEcho").listItems(nodeFor("ear.rhythm.echo"));
    expect(items.length).toBeGreaterThanOrEqual(20);
    for (const it of items) {
      const inst = getGenerator("rhythmEcho").generate(nodeFor("ear.rhythm.echo"), it, ctx(1));
      const on = (inst.expected.play as { onsetsBeats: number[] }).onsetsBeats;
      expect(on[0]).toBe(0);
      expect(on.every((x, i) => i === 0 || x > at(on, i - 1))).toBe(true);
    }
    const sig = new Set(items.map((i) => JSON.stringify(RHYTHM_ONSETS(i.pattern as string))));
    expect(sig.size).toBe(items.length);
  });
});

import { RHYTHM_PATTERNS } from "./rhythm.js";
function RHYTHM_ONSETS(id: string): readonly number[] {
  return (RHYTHM_PATTERNS.find((p) => p.id === id) as { onsetsBeats: readonly number[] })
    .onsetsBeats;
}

describe("degreeLabels", () => {
  it("labels pitch classes relative to the key", () => {
    expect(degreeLabels({ tonic: "C", mode: "major" })).toEqual([
      "1",
      "b2",
      "2",
      "b3",
      "3",
      "4",
      "#4",
      "5",
      "b6",
      "6",
      "b7",
      "7",
    ]);
    const g = degreeLabels({ tonic: "G", mode: "major" });
    expect(g[7]).toBe("1");
    expect(g[0]).toBe("4");
    expect(g[10]).toBe("b3");
  });
});

describe("item generation", { timeout: 30000 }, () => {
  it("item ids are stable across tonics while presentation tonic changes", () => {
    for (const { node, g, params } of ALL) {
      if (g === "rhythmEcho") continue;
      const gen = getGenerator(g);
      const ids = new Set<string>();
      const tonics = new Set<string>();
      for (let s = 0; s < 40; s++) {
        const inst = gen.generate(node, params, ctx(s));
        ids.add(inst.itemId);
        tonics.add(inst.presentation.tonic as string);
        expect(inst.itemId.startsWith(`${node.id}|`)).toBe(true);
      }
      expect(ids.size).toBe(1);
      expect(tonics.size).toBeGreaterThan(1);
    }
    // Same id across generators of the node (R14).
    const n = nodeFor("ear.degrees.major.135");
    expect(getGenerator("degreeSing").generate(n, { degree: 3 }, ctx(1)).itemId).toBe(
      getGenerator("degreeId").generate(n, { degree: 3 }, ctx(2)).itemId,
    );
  });

  it("uses the preferred key when its mode matches, else a key of the item's mode", () => {
    const pref: Key = { tonic: "Eb", mode: "major" };
    const major = nodeFor("ear.degrees.major.135");
    const minor = nodeFor("ear.degrees.minor");
    const a = getGenerator("degreeSing").generate(
      major,
      { degree: 1 },
      ctx(3, { preferredKey: pref }),
    );
    expect(a.presentation.tonic).toBe("Eb");
    const b = getGenerator("degreeSing").generate(
      minor,
      { degree: 1 },
      ctx(3, { preferredKey: pref }),
    );
    expect(b.presentation.mode).toBe("minor");
  });

  it("stimuli start with a cadence in the presentation key (except rhythm)", () => {
    for (const { node, g, params } of ALL) {
      if (g === "rhythmEcho") continue;
      for (let s = 0; s < 6; s++) {
        const inst = getGenerator(g).generate(node, params, ctx(s));
        const key = { tonic: inst.presentation.tonic, mode: inst.presentation.mode } as Key;
        const cad = cadence(key);
        const ev = inst.stimulus.events;
        expect(ev.slice(0, 4).every((e) => e.role === "cadence")).toBe(true);
        expect(ev[0]?.midi[0]).toBe(cad.chords[0]?.bass);
        expect(at(at(ev, 0).midi, 0) % 12).toBe(tonicChroma(key));
        expect(ev.slice(4).every((e) => e.role === "target")).toBe(true);
        expect(ev[4]?.atSec).toBeGreaterThan((ev[3]?.atSec ?? 0) + (ev[3]?.durationSec ?? 0));
      }
    }
  });

  it("rhythm: 4 count-in clicks then the pattern, no cadence", () => {
    const n = nodeFor("ear.rhythm.echo");
    const inst = getGenerator("rhythmEcho").generate(n, { pattern: "r10" }, ctx(5));
    const roles = inst.stimulus.events.map((e) => e.role);
    expect(roles.slice(0, 4)).toEqual(["count-in", "count-in", "count-in", "count-in"]);
    expect(roles.slice(4).every((r) => r === "target")).toBe(true);
    expect(roles).not.toContain("cadence");
    const play = inst.expected.play;
    expect(play?.kind).toBe("rhythm");
    if (play?.kind === "rhythm") {
      expect(play.tempoBpm).toBeGreaterThanOrEqual(80);
      expect(play.tempoBpm).toBeLessThanOrEqual(100);
      expect(play.beatsPerBar).toBe(4);
    }
  });

  it("sung targets are in voice range, played targets in keyboard range, cells diatonic", () => {
    const voices: VoiceRange[] = [VOICE, { low: 55, high: 74 }, { low: 40, high: 64 }];
    for (const { node, g, params } of ALL) {
      if (g === "rhythmEcho") continue;
      for (const voiceRange of voices) {
        for (let s = 0; s < 6; s++) {
          const c = ctx(s, { voiceRange, keyboardRange: KEYBOARD });
          const inst = getGenerator(g).generate(node, params, c);
          const { sing, play } = inst.expected;
          if (sing?.kind === "sungPitch") {
            expect(sing.targetMidi).toBeGreaterThanOrEqual(voiceRange.low);
            expect(sing.targetMidi).toBeLessThanOrEqual(voiceRange.high);
          }
          if (sing?.kind === "sungSequence") {
            for (const m of sing.midi) {
              expect(m).toBeGreaterThanOrEqual(voiceRange.low);
              expect(m).toBeLessThanOrEqual(voiceRange.high);
            }
          }
          const played =
            play?.kind === "pitchClass"
              ? [play.targetMidi]
              : play?.kind === "sequence"
                ? play.midi
                : [];
          for (const m of played) {
            expect(m).toBeGreaterThanOrEqual(KEYBOARD.low);
            expect(m).toBeLessThanOrEqual(KEYBOARD.high);
          }
          if (g === "cellEcho") {
            const key = { tonic: inst.presentation.tonic, mode: inst.presentation.mode } as Key;
            const tonicMidi = inst.presentation.tonicMidi as number;
            const cell = (params as { cell: number[] }).cell;
            expect(sing?.kind === "sungSequence" ? sing.midi : []).toEqual(
              cell.map((d) => degreeToMidi(key, d, tonicMidi)),
            );
            expect(inst.stimulus.events.filter((e) => e.role === "target")).toHaveLength(
              cell.length,
            );
          }
        }
      }
    }
  });

  it("default keyboard range is C3..C6 and sing/play expectations match the spec", () => {
    const n = nodeFor("ear.degrees.major.135");
    const sing = getGenerator("degreeSing").generate(n, { degree: 5 }, ctx(1));
    expect(sing.expected.sing).toMatchObject({ kind: "sungPitch", toleranceCents: 50 });
    expect(sing.expected.play?.kind).toBe("pitchClass");
    expect(sing.expected.responseWindowMs).toBe(10000);
    expect(sing.targetLatencyMs).toBe(1500);
    const id = getGenerator("degreeId").generate(n, { degree: 5 }, ctx(1));
    expect(id.expected.sing).toBeUndefined();
    expect(id.expected.responseWindowMs).toBe(8000);
    const cell = getGenerator("cellEcho").generate(
      nodeFor("ear.cells.major.2-4"),
      { cell: [1, 2, 3] },
      ctx(1),
    );
    expect(cell.itemId).toBe("ear.cells.major.2-4|cell=1-2-3");
    expect(cell.expected.play).toMatchObject({ kind: "sequence", octaveAgnostic: true });
    expect(cell.expected.sing?.kind).toBe("sungSequence");
  });

  it("rejects params outside the node's universe", () => {
    const n = nodeFor("ear.degrees.major.135");
    expect(() => getGenerator("degreeId").generate(n, { degree: 2 }, ctx(1))).toThrow();
    expect(() =>
      getGenerator("rhythmEcho").generate(nodeFor("ear.rhythm.echo"), { pattern: "zz" }, ctx(1)),
    ).toThrow();
  });

  it("is deterministic: same seed and inputs give deep-equal instances", () => {
    for (const { node, g, params } of ALL) {
      const a = getGenerator(g).generate(node, params, ctx(99));
      const b = getGenerator(g).generate(node, params, ctx(99));
      expect(b).toEqual(a);
    }
  });

  it("property: every item in every universe validates across seeds", () => {
    fc.assert(
      fc.property(
        fc.nat(0x7fffffff),
        fc.nat(ALL.length - 1),
        fc.option(fc.constantFrom(...ALL_KEYS), { nil: undefined }),
        (seed, idx, preferred) => {
          const { node, g, params } = at(ALL, idx);
          const inst = getGenerator(g).generate(
            node,
            params,
            ctx(seed, preferred === undefined ? {} : { preferredKey: preferred }),
          );
          expect(ExpectedResponseSchema.safeParse(inst.expected).success).toBe(true);
          expect(JsonObjectSchema.safeParse(inst.presentation).success).toBe(true);
          expect(JsonObjectSchema.safeParse(inst.params).success).toBe(true);
          expect(StimulusSpecSchema.safeParse(inst.stimulus).success).toBe(true);
          expect(inst.itemId).toBe(itemId(node.id, params));
        },
      ),
      { numRuns: 200 },
    );
  });

  it("covers every item of every universe at least once", () => {
    for (const { node, g, params } of ALL) {
      const inst = getGenerator(g).generate(node, params, ctx(7));
      expect(ExpectedResponseSchema.safeParse(inst.expected).success).toBe(true);
    }
  });
});
