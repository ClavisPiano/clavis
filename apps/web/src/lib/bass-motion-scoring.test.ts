import { bassMotion, createRng, type NoteEvent, type SkillNode } from "@clavis/core";
import { scoreAttempt } from "@clavis/scoring";
import { describe, expect, it } from "vitest";

// Integration test: core cannot import scoring and scoring may only import core types, so the web
// app, which depends on both, checks that every bassMotion item scores against its own expected
// roots the way the learner will experience it.
const node: SkillNode = {
  id: "ear.bass.I-IV-V-vi",
  strand: "EAR",
  title: "Bass motion",
  prerequisites: [],
  itemGenerators: ["bassMotion"],
  params: { mode: "major", chords: ["I", "IV", "V", "vi"] },
  mastery: { minAccuracy: 0.9, windowAttempts: 20, distinctSessions: 2 },
  keyDependent: false,
  targetLatencyMs: 4000,
};

function generate(prog: string[], seed = 7) {
  return bassMotion.generate(
    node,
    { prog },
    { rng: createRng(seed), voiceRange: { low: 48, high: 72 }, mode: "away" },
  );
}

function play(midis: number[], source: NoteEvent["source"] = "tap"): NoteEvent[] {
  return midis.map((pitch, i) => ({ pitch, onsetMs: 1000 + 300 + i * 400, confidence: 1, source }));
}

const score = (inst: ReturnType<typeof generate>, notes: NoteEvent[]) =>
  scoreAttempt({ expected: inst.expected, notes, stimulusEndMs: 1000, source: "tap" });

describe("bassMotion against scoreAttempt", () => {
  it("scores every progression correct when its roots are played, in any octave", () => {
    for (const params of bassMotion.listItems(node)) {
      const inst = generate(params.prog as string[]);
      const target = (inst.expected.play as { midi: number[] }).midi;
      for (const shift of [0, 12, -12]) {
        const r = score(inst, play(target.map((m) => m + shift)));
        expect(r.outcome.correct, `${inst.itemId} shift ${String(shift)}`).toBe(true);
        expect(r.errors).toEqual([]);
      }
    }
  });

  it("gives partial credit and names the wrong root as a degree", () => {
    const inst = generate(["I", "IV", "V", "vi"], 3); // roots 1 4 5 6
    const target = (inst.expected.play as { midi: number[] }).midi;
    const wrong = [...target];
    wrong[2] = (target[1] ?? 0) + 0; // plays 4 where 5 was heard
    const r = score(inst, play(wrong));
    expect(r.outcome.correct).toBe(false);
    expect(r.outcome.partial).toBeGreaterThan(0);
    expect(r.outcome.partial).toBeLessThan(1);
    const err = r.errors.find((e) => e.code === "sequence.wrong-note");
    expect(err?.detail).toMatchObject({ index: 2, expectedDegree: "5", playedDegree: "4" });
  });

  it("is incorrect when the roots come in the wrong order or one is missing", () => {
    const inst = generate(["I", "vi", "IV", "V"]);
    const target = (inst.expected.play as { midi: number[] }).midi;
    expect(score(inst, play([...target].reverse())).outcome.correct).toBe(false);
    const missing = score(inst, play(target.slice(0, 3)));
    expect(missing.outcome.correct).toBe(false);
    expect(missing.errors.map((e) => e.code)).toContain("sequence.missing");
  });
});
