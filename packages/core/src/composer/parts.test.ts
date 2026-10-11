import { at } from "../theory/util.js";
import { describe, expect, it } from "vitest";
import { createRng } from "../random.js";
import type { LearnerState } from "../state/types.js";
import { keyFamily, type Key } from "../theory/keys.js";
import { allocate } from "./budget.js";
import { dependsOnHands } from "./compose.js";
import { V1_GRAPH } from "./fixtures/graph.js";
import { newLearner, NOW } from "./fixtures/learners.js";
import { interleave } from "./interleave.js";
import { keyOfDay, unlockedFamilies } from "./key.js";

const DAY = 86_400_000;
const k = (key: Key): string => `${key.tonic} ${key.mode}`;

function withHistory(state: LearnerState, entries: { day: string; key: Key }[]): LearnerState {
  return { ...state, keyOfDayHistory: entries };
}

describe("keyOfDay", () => {
  const day = (offset: number) => new Date(NOW + offset * DAY).toISOString().slice(0, 10);

  it("starts at C major", () => {
    expect(k(keyOfDay(newLearner(), V1_GRAPH, NOW, 0))).toBe("C major");
  });

  it("reuses today's entry", () => {
    const s = withHistory(newLearner(), [{ day: day(0), key: { tonic: "Eb", mode: "major" } }]);
    expect(k(keyOfDay(s, V1_GRAPH, NOW, 0))).toBe("Eb major");
  });

  it("rotates round the circle of fifths inside family A", () => {
    const seq: string[] = [];
    let s = newLearner();
    for (let i = 0; i < 7; i++) {
      const key = keyOfDay(s, V1_GRAPH, NOW + i * DAY, 0);
      seq.push(k(key));
      s = withHistory(s, [...s.keyOfDayHistory, { day: day(i), key }]);
    }
    expect(seq).toEqual([
      "C major",
      "G major",
      "F major",
      "C major",
      "G major",
      "F major",
      "C major",
    ]);
  });

  it("opens family B after a key-dependent node is mastered in A", () => {
    const s = newLearner();
    expect(unlockedFamilies(s, V1_GRAPH)).toEqual(["A"]);
    s.nodes["read.bass.landmarks"] = { state: "learning", byFamily: { A: "mastered" } };
    expect(unlockedFamilies(s, V1_GRAPH)).toEqual(["A", "B"]);
    const next = keyOfDay(
      withHistory(s, [{ day: day(-1), key: { tonic: "G", mode: "major" } }]),
      V1_GRAPH,
      NOW,
      0,
    );
    expect(next).toEqual({ tonic: "D", mode: "major" });
    expect(keyFamily(next)).toBe("B");
    s.nodes["read.bass.landmarks"] = {
      state: "learning",
      byFamily: { A: "mastered", B: "fluent" },
    };
    expect(unlockedFamilies(s, V1_GRAPH)).toEqual(["A", "B", "C"]);
  });

  it("alternates minor on odd days once a minor ear node is learning", () => {
    const s = withHistory(newLearner(), [{ day: day(-1), key: { tonic: "C", mode: "major" } }]);
    s.nodes["ear.degrees.minor"] = { state: "learning" };
    const modes = [0, 1].map((i) => keyOfDay(s, V1_GRAPH, NOW + i * DAY, 0).mode);
    expect(new Set(modes).size).toBe(2);
    const minor = keyOfDay(s, V1_GRAPH, NOW + DAY * (modes[0] === "minor" ? 0 : 1), 0);
    expect(k(minor)).toBe("E minor");
  });
});

describe("allocate", () => {
  it("splits 10/30/25/35 when every block has content", () => {
    const a = allocate({
      budgetSec: 720,
      mode: "instrument",
      readHasContent: true,
      applyHasContent: true,
    });
    expect(a).toMatchObject({
      orientSec: 72,
      earSec: 216,
      readSec: 180,
      applySec: 252,
      reallocatedSec: 0,
    });
  });

  it("moves empty read and apply shares to ear", () => {
    const a = allocate({
      budgetSec: 720,
      mode: "instrument",
      readHasContent: false,
      applyHasContent: false,
    });
    expect(a).toMatchObject({
      orientSec: 72,
      earSec: 648,
      readSec: 0,
      applySec: 0,
      reallocatedSec: 432,
    });
  });

  it("drops apply, trims read and holds orient at 300 s or less", () => {
    const a = allocate({
      budgetSec: 300,
      mode: "instrument",
      readHasContent: true,
      applyHasContent: true,
    });
    expect(a).toMatchObject({ orientSec: 30, readSec: 38, applySec: 0 });
    expect(a.orientSec + a.earSec + a.readSec + a.applySec).toBe(300);
    const tiny = allocate({
      budgetSec: 60,
      mode: "instrument",
      readHasContent: false,
      applyHasContent: false,
    });
    expect(tiny.orientSec).toBe(20);
  });

  it("gives away mode the whole budget as ear", () => {
    const a = allocate({
      budgetSec: 300,
      mode: "away",
      readHasContent: true,
      applyHasContent: true,
    });
    expect(a).toMatchObject({ orientSec: 0, earSec: 300, readSec: 0, applySec: 0 });
  });
});

describe("interleave", () => {
  const it_ = (nodeId: string, generator: string, isNew = false) => ({ nodeId, generator, isNew });

  it("separates same-type neighbours when possible", () => {
    const items = [
      it_("a", "g"),
      it_("a", "g"),
      it_("a", "g"),
      it_("b", "g"),
      it_("b", "g"),
      it_("c", "g"),
    ];
    const out = interleave(items, createRng(1));
    expect(out).toHaveLength(6);
    for (let i = 1; i < out.length; i++) expect(out[i]?.nodeId).not.toBe(out[i - 1]?.nodeId);
  });

  it("spreads new items instead of leaving them at the end", () => {
    const items = [
      ...Array.from({ length: 6 }, (_, i) => it_(`n${String(i)}`, "g")),
      it_("x", "g", true),
      it_("y", "g", true),
    ];
    const out = interleave(items, createRng(3));
    const pos = out.flatMap((o, i) => (o.isNew ? [i] : []));
    expect(pos[0]).toBeLessThan(5);
    expect(pos[1]).toBeLessThan(8);
    expect(at(pos, 1) - at(pos, 0)).toBeGreaterThanOrEqual(2);
  });

  it("is deterministic for a seed", () => {
    const items = Array.from({ length: 10 }, (_, i) => it_(`n${String(i % 4)}`, "g", i % 5 === 0));
    expect(interleave(items, createRng(9))).toEqual(interleave(items, createRng(9)));
  });
});

describe("dependsOnHands", () => {
  it("follows hard prerequisite chains", () => {
    expect(dependsOnHands(V1_GRAPH, "hands.lh.triads.root")).toBe(true);
    expect(dependsOnHands(V1_GRAPH, "ear.degrees.major.135")).toBe(false);
    const graph = {
      ...V1_GRAPH,
      nodes: [
        ...V1_GRAPH.nodes,
        {
          ...at(V1_GRAPH.nodes, 0),
          id: "ear.x",
          prerequisites: ["ear.degrees.major.135", "hands.lh.triads.root"],
        },
      ],
    };
    expect(dependsOnHands(graph, "ear.x")).toBe(true);
  });
});
