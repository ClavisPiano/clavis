import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { SkillNode } from "../graph/schema.js";
import { createRng } from "../random.js";
import { ScoreSpecSchema, scoreNoteIds } from "../score/schema.js";
import { StimulusSpecSchema } from "../stimulus/types.js";
import { keyFamily, keysInFamilies, type Key, type KeyFamily } from "../theory/keys.js";
import { parseStaffPosition, staffPosition } from "../theory/staff.js";
import { ExpectedResponseSchema } from "./expected.js";
import { bassNoteRead } from "./bass-note-read.js";
import type { GenerateContext, ItemParams } from "./types.js";

const mastery = { minAccuracy: 0.9, windowAttempts: 20, distinctSessions: 2 };
const base: Omit<SkillNode, "id" | "params"> = {
  strand: "READ",
  title: "t",
  prerequisites: [],
  itemGenerators: ["bassNoteRead"],
  mastery,
  keyDependent: true,
  targetLatencyMs: 1200,
};
const ANCHORS = ["C2", "F3", "C4", "G2"];

const landmarks: SkillNode = {
  ...base,
  id: "read.bass.landmarks",
  params: { clef: "bass", notes: ANCHORS },
};
const steps: SkillNode = {
  ...base,
  id: "read.bass.steps",
  params: { clef: "bass", anchors: ANCHORS, maxOffsetSteps: 1 },
};
const skips: SkillNode = {
  ...base,
  id: "read.bass.skips",
  params: { clef: "bass", anchors: ANCHORS, maxOffsetSteps: 2, fullRange: ["C2", "E4"] },
};
const minor: SkillNode = {
  ...base,
  id: "read.minor.accidentals",
  params: { clef: "bass", mode: "minor", accidentals: ["raised6", "raised7"] },
};

const ctx = (seed: number, preferredKey?: Key): GenerateContext => ({
  rng: createRng(seed),
  mode: "instrument",
  ...(preferredKey === undefined ? {} : { preferredKey }),
});

const famOf = (p: ItemParams): KeyFamily => z.enum(["A", "B", "C"]).parse(p.fam);
const keyOf = (i: { presentation: Record<string, unknown> }): Key =>
  z.object({ tonic: z.string(), mode: z.enum(["major", "minor"]) }).parse(i.presentation.key);

describe("bassNoteRead universe", () => {
  it.each([
    ["landmarks", landmarks, 12],
    ["steps", steps, 21],
    ["skips", skips, 51],
    ["minor accidentals", minor, 6],
  ] as const)("%s has %i items", (_n, node, size) => {
    const items = bassNoteRead.listItems(node);
    expect(items).toHaveLength(size);
    const ids = items.map((p) => JSON.stringify(p));
    expect(new Set(ids).size).toBe(size);
  });

  it("steps excludes anchors and out-of-range B1", () => {
    const pos = bassNoteRead
      .listItems(steps)
      .filter((p) => p.fam === "A")
      .map((p) => z.string().parse(p.pos));
    expect(pos).toEqual(["D2", "F2", "A2", "E3", "G3", "B3", "D4"]);
  });

  it("landmarks are the node notes in order, per family", () => {
    expect(bassNoteRead.listItems(landmarks).slice(0, 4)).toEqual(
      ANCHORS.map((pos) => ({ fam: "A", pos })),
    );
  });
});

describe("bassNoteRead generate", () => {
  it("builds the R15 item id and presentation", () => {
    const inst = bassNoteRead.generate(landmarks, { fam: "A", pos: "F3" }, ctx(1));
    expect(inst.itemId).toBe("read.bass.landmarks|fam=A|pos=F3");
    expect(inst.generator).toBe("bassNoteRead");
    expect(inst.presentation).toMatchObject({ clef: "bass", fam: "A", pos: "F3" });
    expect(inst.stimulus).toEqual({ events: [] });
    expect(StimulusSpecSchema.safeParse(inst.stimulus).success).toBe(true);
    expect(ExpectedResponseSchema.safeParse(inst.expected).success).toBe(true);
    expect(inst.expected.responseWindowMs).toBe(6000);
    expect(inst.targetLatencyMs).toBe(1200);
  });

  it("F3 in G major has no written accidental and sounds 54", () => {
    const inst = bassNoteRead.generate(
      landmarks,
      { fam: "A", pos: "F3" },
      ctx(1, { tonic: "G", mode: "major" }),
    );
    expect(inst.expected.play).toEqual({ kind: "exactPitch", targetMidi: 54 });
    const n = inst.display?.staves[0]?.measures[0]?.[0];
    expect(n).toMatchObject({ pitches: [{ step: "F", alter: 1, octave: 3 }] });
    expect(n).not.toHaveProperty("accidental");
    expect(inst.display?.key).toEqual({ tonic: "G", mode: "major" });
  });

  it("D minor raised 7 writes C sharp", () => {
    for (let seed = 0; seed < 20; seed++) {
      const inst = bassNoteRead.generate(
        minor,
        { fam: "A", raise: 7 },
        ctx(seed, { tonic: "D", mode: "minor" }),
      );
      const n = inst.display?.staves[0]?.measures[0]?.[0];
      expect(n).toMatchObject({ accidental: "sharp", pitches: [{ step: "C", alter: 1 }] });
      expect(inst.itemId).toBe("read.minor.accidentals|fam=A|raise=7");
      expect(inst.presentation).toMatchObject({ raise: 7 });
    }
  });

  it("G minor raised 6 writes E natural", () => {
    const inst = bassNoteRead.generate(
      minor,
      { fam: "B", raise: 6 },
      ctx(3, { tonic: "G", mode: "minor" }),
    );
    expect(inst.display?.staves[0]?.measures[0]?.[0]).toMatchObject({
      accidental: "natural",
      pitches: [{ step: "E", alter: 0 }],
    });
  });

  it("uses the preferred key when in family and mode, else a key of the family", () => {
    const pref: Key = { tonic: "G", mode: "major" };
    const a = bassNoteRead.generate(landmarks, { fam: "A", pos: "C2" }, ctx(5, pref));
    expect(keyFamily(keyOf(a))).toBe("A");
    expect(keyOf(a)).toEqual(pref);
    const c = bassNoteRead.generate(landmarks, { fam: "C", pos: "C2" }, ctx(5, pref));
    expect(keyFamily(keyOf(c))).toBe("C");
    const m = bassNoteRead.generate(minor, { fam: "A", raise: 6 }, ctx(5, pref));
    expect(keyOf(m).mode).toBe("minor");
  });

  it("is deterministic per seed", () => {
    for (const node of [landmarks, steps, skips, minor]) {
      for (const p of bassNoteRead.listItems(node)) {
        expect(bassNoteRead.generate(node, p, ctx(11))).toEqual(
          bassNoteRead.generate(node, p, ctx(11)),
        );
      }
    }
  });

  it("rejects positions outside the node", () => {
    expect(() => bassNoteRead.generate(landmarks, { fam: "A", pos: "D3" }, ctx(1))).toThrow();
    expect(() => bassNoteRead.generate(minor, { fam: "A", raise: 5 }, ctx(1))).toThrow();
  });

  it("covers every key of every family for every item", () => {
    for (const node of [landmarks, steps, skips, minor]) {
      for (const p of bassNoteRead.listItems(node)) {
        const fam = famOf(p);
        const mode = node === minor ? "minor" : "major";
        for (const k of keysInFamilies([fam]).filter((x) => x.mode === mode)) {
          const inst = bassNoteRead.generate(node, p, ctx(2, k));
          expect(keyOf(inst)).toEqual(k);
          expect(inst.itemId).toBe(bassNoteRead.generate(node, p, ctx(9)).itemId);
        }
      }
    }
  });

  it("property: family, range, display validity and id", () => {
    const nodes = [landmarks, steps, skips, minor];
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: nodes.length - 1 }),
        fc.nat(),
        fc.integer({ min: 0, max: 0x7fffffff }),
        (ni, pi, seed) => {
          const node = at(nodes, ni);
          const items = bassNoteRead.listItems(node);
          const p = at(items, pi % items.length);
          const inst = bassNoteRead.generate(node, p, ctx(seed));
          expect(keyFamily(keyOf(inst))).toBe(famOf(p));
          expect(inst.presentation.fam).toBe(famOf(p));
          expect(inst.itemId).toContain(`fam=${famOf(p)}`);
          expect(inst.params).toEqual(p);
          const target = inst.expected.play;
          if (target?.kind !== "exactPitch") throw new Error("expected exactPitch");
          expect(inst.presentation.midi).toBe(target.targetMidi);
          expect(inst.inputRange).toBeDefined();
          expect(target.targetMidi).toBeGreaterThanOrEqual(inst.inputRange?.low ?? 999);
          expect(target.targetMidi).toBeLessThanOrEqual(inst.inputRange?.high ?? -1);
          const parsed = ScoreSpecSchema.safeParse(inst.display);
          expect(parsed.success).toBe(true);
          if (inst.display) {
            expect(scoreNoteIds(inst.display)).toEqual(["n1"]);
            expect(inst.display.staves[0]?.clef).toBe("bass");
            expect(inst.display.meter).toBeNull();
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

function at<T>(xs: readonly T[], i: number): T {
  const x = xs[i];
  if (x === undefined) throw new RangeError(`index ${String(i)}`);
  return x;
}

const intervals: SkillNode = {
  ...base,
  id: "read.bass.intervals",
  params: { clef: "bass", mode: "interval", maxIntervalSteps: 4 },
};

const posList = (i: { presentation: Record<string, unknown> }): string[] =>
  z.array(z.string()).parse(i.presentation.pos);

describe("bassNoteRead interval variant", () => {
  it("has 3 x 4 x 2 = 24 items with R18 ids", () => {
    const items = bassNoteRead.listItems(intervals);
    expect(items).toHaveLength(24);
    expect(items[0]).toEqual({ fam: "A", interval: 2, dir: "up" });
    const inst = bassNoteRead.generate(intervals, { fam: "A", interval: 3, dir: "up" }, ctx(1));
    expect(inst.itemId).toBe("read.bass.intervals|dir=up|fam=A|interval=3");
  });

  it("two half notes, exact-octave sequence target", () => {
    const inst = bassNoteRead.generate(
      intervals,
      { fam: "A", interval: 5, dir: "up" },
      ctx(4, { tonic: "C", mode: "major" }),
    );
    expect(ScoreSpecSchema.safeParse(inst.display).success).toBe(true);
    expect(inst.display ? scoreNoteIds(inst.display) : []).toEqual(["n1", "n2"]);
    expect(inst.display?.staves[0]?.measures).toHaveLength(1);
    expect(inst.stimulus).toEqual({ events: [] });
    const play = inst.expected.play;
    if (play?.kind !== "sequence") throw new Error("expected sequence");
    expect(play.octaveAgnostic).toBe(false);
    expect(play.midi).toHaveLength(2);
    expect(inst.expected.responseWindowMs).toBe(10000);
    expect(ExpectedResponseSchema.safeParse(inst.expected).success).toBe(true);
  });

  it("every item in every key: first is a landmark, step distance matches, both in range", () => {
    const low = staffPosition(parseStaffPosition("C2"));
    const high = staffPosition(parseStaffPosition("E4"));
    for (const p of bassNoteRead.listItems(intervals)) {
      const fam = famOf(p);
      const interval = z.number().parse(p.interval);
      const dir = z.enum(["up", "down"]).parse(p.dir);
      for (const k of keysInFamilies([fam]).filter((x) => x.mode === "major")) {
        for (let seed = 0; seed < 6; seed++) {
          const inst = bassNoteRead.generate(intervals, p, ctx(seed, k));
          expect(keyOf(inst)).toEqual(k);
          const pos = posList(inst);
          expect(ANCHORS).toContain(pos[0]);
          const a = staffPosition(parseStaffPosition(pos[0] ?? ""));
          const b = staffPosition(parseStaffPosition(pos[1] ?? ""));
          expect(b - a).toBe((interval - 1) * (dir === "up" ? 1 : -1));
          for (const i of [a, b]) {
            expect(i).toBeGreaterThanOrEqual(low);
            expect(i).toBeLessThanOrEqual(high);
          }
          const midis = z.array(z.number()).parse(inst.presentation.midi);
          for (const m of midis) {
            expect(m).toBeGreaterThanOrEqual(inst.inputRange?.low ?? 999);
            expect(m).toBeLessThanOrEqual(inst.inputRange?.high ?? -1);
          }
          expect(inst.expected.play).toMatchObject({ kind: "sequence", midi: midis });
          expect(inst.itemId).toBe(bassNoteRead.generate(intervals, p, ctx(99)).itemId);
        }
      }
    }
  });

  it("is deterministic per seed and the landmark varies with the seed", () => {
    const p = { fam: "A", interval: 2, dir: "up" };
    expect(bassNoteRead.generate(intervals, p, ctx(7))).toEqual(
      bassNoteRead.generate(intervals, p, ctx(7)),
    );
    const firsts = new Set<string | undefined>();
    for (let s = 0; s < 40; s++)
      firsts.add(posList(bassNoteRead.generate(intervals, p, ctx(s)))[0]);
    expect(firsts.size).toBeGreaterThan(1);
  });

  it("rejects intervals the node does not allow", () => {
    expect(() =>
      bassNoteRead.generate(intervals, { fam: "A", interval: 6, dir: "up" }, ctx(1)),
    ).toThrow();
  });
});
