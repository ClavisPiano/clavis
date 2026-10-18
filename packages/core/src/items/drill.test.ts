import { describe, expect, it } from "vitest";
import type { SkillNode } from "../graph/schema.js";
import type { JsonObject } from "../json.js";
import { createRng } from "../random.js";
import { coordTask } from "./coord-task.js";
import {
  drillParamsOf,
  drillProgression,
  isDrillItemId,
  spawnDrill,
  type SpawnedDrill,
} from "./drill.js";
import type { ExpectedResponse } from "./expected.js";
import { itemId } from "./ids.js";
import { lhPatternVariants } from "./lh-pattern-variants.js";
import { lhPattern } from "./lh-pattern.js";
import type { GenerateContext, Generator, ItemParams } from "./types.js";

/* Error micro-drills (T5.8, R27). */

const CHORDS = ["I", "IV", "V", "vi"];
const base = {
  strand: "HANDS" as const,
  title: "t",
  prerequisites: [],
  mastery: { minAccuracy: 0.8, windowAttempts: 5, distinctSessions: 2 },
  keyDependent: true,
};
const ROOT: SkillNode = {
  ...base,
  id: "hands.lh.triads.root",
  itemGenerators: ["lhPattern"],
  params: { pattern: "block", chords: CHORDS, inversion: "root" },
};
const INV: SkillNode = {
  ...base,
  id: "hands.lh.inversions",
  itemGenerators: ["lhPatternVariants"],
  params: {
    pattern: "block",
    voiceLeading: "close",
    inversions: ["root", "first", "second"],
    chords: CHORDS,
  },
};
const BROKEN: SkillNode = {
  ...base,
  id: "hands.lh.broken",
  itemGenerators: ["lhPatternVariants"],
  params: { patterns: ["broken", "alberti"], chords: CHORDS },
};
const COORD: SkillNode = {
  ...base,
  id: "hands.coord.basic",
  itemGenerators: ["coordTask"],
  params: { rh: "melody", lh: "block", chords: CHORDS },
};

const ctx = (seed = 1): GenerateContext => ({
  rng: createRng(seed),
  mode: "instrument",
  preferredKey: { tonic: "G", mode: "major" },
});

const PROG = ["I", "IV", "V", "I"];
const err = (code: string, detail: JsonObject = {}) => ({ code, detail });
const chordLine = lhPattern.generate(ROOT, { fam: "A", prog: PROG }, ctx()).expected;
const performance = coordTask.generate(COORD, { fam: "A", prog: PROG, mel: 1 }, ctx()).expected;
const line = lhPatternVariants.generate(
  BROKEN,
  { fam: "A", pattern: "broken", prog: PROG },
  ctx(),
).expected;

describe("spawnDrill", () => {
  const drill = (
    expected: ExpectedResponse,
    errors: { code: string; detail?: JsonObject }[],
    o: { correct?: boolean; params?: ItemParams; nodeId?: string } = {},
  ): Pick<SpawnedDrill, "from" | "to" | "itemId"> | undefined => {
    const out = spawnDrill({
      nodeId: o.nodeId ?? ROOT.id,
      params: o.params ?? { fam: "A", prog: PROG },
      expected,
      correct: o.correct ?? false,
      errors,
    });
    return out && { from: out.from, to: out.to, itemId: out.itemId };
  };

  it.each<[string, ExpectedResponse, { code: string; detail?: JsonObject }[], string | undefined]>([
    [
      "a wrong tone in V: the change IV to V",
      chordLine,
      [err("chord.wrong-tone", { index: 2 })],
      "IV-V",
    ],
    ["a missed IV: I to IV", chordLine, [err("chord.missed", { index: 1 })], "I-IV"],
    ["a late last chord: V to I", chordLine, [err("chord.late", { index: 3 })], "V-I"],
    [
      "the first chord wrong: the change out of it",
      chordLine,
      [err("chord.missing-tone", { index: 0 })],
      "I-IV",
    ],
    [
      "the earliest of several, whatever their order",
      chordLine,
      [
        err("chord.wrong-tone", { index: 3 }),
        err("chord.late", { index: 2 }),
        err("chord.extra", { count: 1 }),
      ],
      "IV-V",
    ],
    [
      "only an extra note: nothing to drill",
      chordLine,
      [err("chord.extra", { count: 2 })],
      undefined,
    ],
    ["no answer", chordLine, [{ code: "response.timeout" }], undefined],
    ["a skip", chordLine, [{ code: "response.skipped" }], undefined],
    [
      "a wrong LH note in bar 3: IV to V",
      performance,
      [err("note.wrong", { measure: 3, beat: 1, hand: "lh" })],
      "IV-V",
    ],
    [
      "a late RH note in bar 2, beat 4: I to IV",
      performance,
      [err("note.late", { measure: 2, beat: 4, hand: "rh" })],
      "I-IV",
    ],
    [
      "bar 4 and bar 3: the earlier wins",
      performance,
      [
        err("note.missed", { measure: 4, beat: 1, hand: "lh" }),
        err("note.extra", { measure: 3, beat: 2.5, hand: "rh" }),
      ],
      "IV-V",
    ],
    ["a line pattern never drills", line, [err("pitch.wrong", { index: 2 })], undefined],
  ])("%s", (_name, expected, errors, change) => {
    const out = drill(
      expected,
      errors,
      expected === performance
        ? { nodeId: COORD.id, params: { fam: "A", prog: PROG, mel: 1 } }
        : {},
    );
    if (change === undefined) {
      expect(out).toBeUndefined();
    } else {
      const nodeId = expected === performance ? COORD.id : ROOT.id;
      expect(out).toEqual({
        from: change.split("-")[0],
        to: change.split("-")[1],
        itemId: `${nodeId}|drill=${change}|fam=A`,
      });
    }
  });

  it("spawns nothing for a correct attempt or a drill", () => {
    const errors = [err("chord.wrong-tone", { index: 2 })];
    expect(drill(chordLine, errors, { correct: true })).toBeUndefined();
    expect(drill(chordLine, errors, { params: { fam: "A", drill: "IV-V" } })).toBeUndefined();
    expect(drill(chordLine, errors, { params: { prog: PROG } })).toBeUndefined();
  });
});

describe("drill ids", () => {
  it("read back their params, and only canonical ones", () => {
    const id = itemId(ROOT.id, { fam: "B", drill: "V-vi" });
    expect(id).toBe("hands.lh.triads.root|drill=V-vi|fam=B");
    expect(isDrillItemId(id)).toBe(true);
    expect(drillParamsOf(ROOT.id, id)).toEqual({ fam: "B", drill: "V-vi" });
    expect(drillParamsOf(COORD.id, id)).toBeUndefined();
    expect(drillParamsOf(ROOT.id, "hands.lh.triads.root|fam=B|drill=V-vi")).toBeUndefined();
    expect(drillParamsOf(ROOT.id, "hands.lh.triads.root|drill=V-V|fam=B")).toBeUndefined();
    expect(drillParamsOf(ROOT.id, "hands.lh.triads.root|drill=V-vi|fam=D")).toBeUndefined();
    expect(isDrillItemId("hands.lh.triads.root|fam=A|prog=I-IV-V-I")).toBe(false);
    expect(drillProgression("IV-V")).toEqual(["IV", "V", "IV", "V"]);
    expect(() => drillProgression("IV")).toThrow();
  });
});

const PAIRS = CHORDS.flatMap((a) => CHORDS.filter((b) => b !== a).map((b) => `${a}-${b}`));

describe.each<[string, SkillNode, Generator, "chordLine" | "performance"]>([
  ["lhPattern", ROOT, lhPattern, "chordLine"],
  ["lhPatternVariants inversions", INV, lhPatternVariants, "chordLine"],
  ["coordTask", COORD, coordTask, "performance"],
])("%s drills", (_name, node, gen, kind) => {
  it("are never listed", () => {
    expect(gen.listItems(node).some((p) => "drill" in p)).toBe(false);
  });

  it.each(PAIRS)("generates %s as the two chords played twice", (change) => {
    const params = { fam: "A", drill: change };
    const inst = gen.generate(node, params, ctx(3));
    const [from, to] = change.split("-");
    expect(inst.itemId).toBe(itemId(node.id, params));
    expect(inst.params).toEqual(params);
    expect(inst.presentation.prog).toEqual([from, to, from, to]);
    expect(inst.expected.play?.kind).toBe(kind);
    const play = inst.expected.play;
    if (play?.kind === "chordLine")
      expect(play.chords.map((c) => c.roman)).toEqual([from, to, from, to]);
  });

  it("reject a chord the node does not have, and a malformed drill", () => {
    expect(() => gen.generate(node, { fam: "A", drill: "I-ii" }, ctx())).toThrow();
    expect(() => gen.generate(node, { fam: "A", drill: "IV-IV" }, ctx())).toThrow();
    expect(() => gen.generate(node, { fam: "A", drill: "IV-V", prog: PROG }, ctx())).toThrow();
  });
});

describe("line patterns", () => {
  it("do not take drills", () => {
    expect(() => lhPatternVariants.generate(BROKEN, { fam: "A", drill: "IV-V" }, ctx())).toThrow();
  });
});
