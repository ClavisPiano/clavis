import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { SkillNode } from "../graph/schema.js";
import { createRng } from "../random.js";
import { ScoreSpecSchema, scoreNoteIds } from "../score/schema.js";
import { StimulusSpecSchema } from "../stimulus/types.js";
import { keyFamily, keysInFamilies, type Key } from "../theory/keys.js";
import { ExpectedResponseSchema } from "./expected.js";
import { bassNoteRead } from "./bass-note-read.js";
import { TREBLE_READ_RANGE, trebleNoteRead } from "./treble-note-read.js";
import type { GenerateContext } from "./types.js";

const base: Omit<SkillNode, "id" | "params"> = {
  strand: "READ",
  title: "t",
  prerequisites: [],
  itemGenerators: ["trebleNoteRead"],
  mastery: { minAccuracy: 0.9, windowAttempts: 20, distinctSessions: 2 },
  keyDependent: true,
  targetLatencyMs: 1200,
};
const ANCHORS = ["C4", "G4", "C5"];
const landmarks: SkillNode = {
  ...base,
  id: "read.treble.landmarks",
  params: { clef: "treble", notes: ANCHORS },
};
const steps: SkillNode = {
  ...base,
  id: "read.treble.steps",
  params: { clef: "treble", anchors: ANCHORS, maxOffsetSteps: 1 },
};
const skips: SkillNode = {
  ...base,
  id: "read.treble.skips",
  params: { clef: "treble", anchors: ANCHORS, maxOffsetSteps: 2, fullRange: ["C4", "A5"] },
};

const ctx = (seed: number, preferredKey?: Key): GenerateContext => ({
  rng: createRng(seed),
  mode: "instrument",
  ...(preferredKey === undefined ? {} : { preferredKey }),
});
const keyOf = (i: { presentation: Record<string, unknown> }): Key =>
  z.object({ tonic: z.string(), mode: z.enum(["major", "minor"]) }).parse(i.presentation.key);

describe("trebleNoteRead universe", () => {
  it.each([
    ["landmarks", landmarks, 9],
    ["steps", steps, 15],
    ["skips", skips, 39],
  ] as const)("%s has %i items, all distinct", (_n, node, size) => {
    const items = trebleNoteRead.listItems(node);
    expect(items).toHaveLength(size);
    expect(new Set(items.map((p) => JSON.stringify(p))).size).toBe(size);
  });

  it("steps are one step from a landmark, never a landmark, inside the range", () => {
    const pos = trebleNoteRead
      .listItems(steps)
      .filter((p) => p.fam === "A")
      .map((p) => z.string().parse(p.pos));
    expect(pos).toEqual(["D4", "F4", "A4", "B4", "D5"]);
  });

  it("skips cover middle C up to the A above the staff", () => {
    const pos = trebleNoteRead
      .listItems(skips)
      .filter((p) => p.fam === "A")
      .map((p) => z.string().parse(p.pos));
    expect(pos).toEqual([
      "C4",
      "D4",
      "E4",
      "F4",
      "G4",
      "A4",
      "B4",
      "C5",
      "D5",
      "E5",
      "F5",
      "G5",
      "A5",
    ]);
  });

  it("landmarks are the node notes in order, per family", () => {
    expect(trebleNoteRead.listItems(landmarks).slice(0, 3)).toEqual(
      ANCHORS.map((pos) => ({ fam: "A", pos })),
    );
  });
});

describe("trebleNoteRead generate", () => {
  it("builds the R15 item id and a treble display", () => {
    const inst = trebleNoteRead.generate(landmarks, { fam: "A", pos: "G4" }, ctx(1));
    expect(inst.itemId).toBe("read.treble.landmarks|fam=A|pos=G4");
    expect(inst.generator).toBe("trebleNoteRead");
    expect(inst.presentation).toMatchObject({ clef: "treble", fam: "A", pos: "G4" });
    expect(inst.display?.staves[0]?.clef).toBe("treble");
    expect(inst.stimulus).toEqual({ events: [] });
    expect(StimulusSpecSchema.safeParse(inst.stimulus).success).toBe(true);
    expect(ExpectedResponseSchema.safeParse(inst.expected).success).toBe(true);
    expect(ScoreSpecSchema.safeParse(inst.display).success).toBe(true);
    expect(inst.expected.responseWindowMs).toBe(6000);
    expect(inst.targetLatencyMs).toBe(1200);
  });

  // Table: key, position, expected sounding MIDI.
  it.each([
    [{ tonic: "C", mode: "major" }, "C4", 60],
    [{ tonic: "C", mode: "major" }, "G4", 67],
    [{ tonic: "C", mode: "major" }, "C5", 72],
    [{ tonic: "G", mode: "major" }, "F4", 66],
    [{ tonic: "F", mode: "major" }, "B4", 70],
    [{ tonic: "D", mode: "major" }, "C5", 73],
  ] as const)("in %j the note %s sounds %i", (key, pos, midi) => {
    const inst = trebleNoteRead.generate(skips, { fam: keyFamily(key), pos }, ctx(2, key));
    expect(inst.expected.play).toEqual({ kind: "exactPitch", targetMidi: midi });
    expect(inst.presentation).toMatchObject({ midi });
  });

  it("the key signature implies the accidental, so none is written", () => {
    const inst = trebleNoteRead.generate(
      skips,
      { fam: "A", pos: "F4" },
      ctx(1, { tonic: "G", mode: "major" }),
    );
    const n = inst.display?.staves[0]?.measures[0]?.[0];
    expect(n).toMatchObject({ pitches: [{ step: "F", alter: 1, octave: 4 }] });
    expect(n).not.toHaveProperty("accidental");
  });

  it("uses the preferred key when it is in the family, and the default range for the keyboard", () => {
    const inst = trebleNoteRead.generate(
      landmarks,
      { fam: "A", pos: "C4" },
      ctx(5, { tonic: "G", mode: "major" }),
    );
    expect(keyOf(inst)).toEqual({ tonic: "G", mode: "major" });
    expect(inst.inputRange).toEqual({ low: TREBLE_READ_RANGE.low, high: TREBLE_READ_RANGE.high });
  });

  it("is deterministic for a seed and shares nothing with the bass generator", () => {
    const p = { fam: "B" as const, pos: "E4" };
    expect(trebleNoteRead.generate(skips, p, ctx(9))).toEqual(
      trebleNoteRead.generate(skips, p, ctx(9)),
    );
    expect(trebleNoteRead.id).toBe("trebleNoteRead");
    expect(bassNoteRead.id).toBe("bassNoteRead");
  });

  it("rejects positions outside the node", () => {
    expect(() => trebleNoteRead.generate(landmarks, { fam: "A", pos: "D4" }, ctx(1))).toThrow(
      RangeError,
    );
  });

  it("property: every item of every node, in every key of its family, validates", () => {
    const all = [landmarks, steps, skips].flatMap((node) =>
      trebleNoteRead.listItems(node).map((params) => ({ node, params })),
    );
    fc.assert(
      fc.property(fc.nat(0x7fffffff), fc.nat(all.length - 1), (seed, idx) => {
        const item = all[idx];
        if (!item) throw new Error("no item");
        const fam = z.enum(["A", "B", "C"]).parse(item.params.fam);
        const key = createRng(seed).pick(keysInFamilies([fam]).filter((k) => k.mode === "major"));
        const inst = trebleNoteRead.generate(item.node, item.params, ctx(seed, key));
        expect(keyFamily(keyOf(inst))).toBe(fam);
        const display = ScoreSpecSchema.parse(inst.display);
        expect(scoreNoteIds(display)).toEqual(["n1"]);
        expect(ExpectedResponseSchema.safeParse(inst.expected).success).toBe(true);
        const play = inst.expected.play;
        if (play?.kind !== "exactPitch") throw new Error("expected an exact pitch");
        const range = inst.inputRange;
        expect(play.targetMidi).toBeGreaterThanOrEqual(range?.low ?? 0);
        expect(play.targetMidi).toBeLessThanOrEqual(range?.high ?? 127);
      }),
      { numRuns: 200 },
    );
  });
});
