import { describe, expect, it } from "vitest";
import { createRng } from "../random.js";
import type { NodeRecord } from "../state/types.js";
import { keyFamily, type Key, type KeyFamily, type Mode } from "../theory/keys.js";
import { familyOfParams, keyForFamily, openFamilies } from "./family.js";

describe("openFamilies", () => {
  const cases: [string, NodeRecord, KeyFamily[]][] = [
    ["learning only", { state: "learning" }, ["A"]],
    ["A mastered", { state: "learning", byFamily: { A: "mastered" } }, ["A", "B"]],
    [
      "A mastered and B fluent",
      { state: "fluent", byFamily: { A: "mastered", B: "fluent" } },
      ["A", "B", "C"],
    ],
    [
      "B mastered",
      { state: "mastered", byFamily: { A: "mastered", B: "mastered" } },
      ["A", "B", "C"],
    ],
    ["B learning", { state: "learning", byFamily: { A: "mastered", B: "learning" } }, ["A", "B"]],
    ["A fluent only", { state: "fluent", byFamily: { A: "fluent" } }, ["A"]],
    ["available", { state: "available" }, []],
    ["locked", { state: "locked" }, []],
  ];
  it.each(cases)("%s", (_n, rec, expected) => {
    expect(openFamilies(rec)).toEqual(expected);
  });
});

describe("keyForFamily", () => {
  const fams: KeyFamily[] = ["A", "B", "C"];
  const modes: Mode[] = ["major", "minor"];

  it("uses the preferred key when it fits family and mode", () => {
    const pref: Key = { tonic: "D", mode: "major" };
    expect(keyForFamily("B", "major", pref, createRng(1))).toEqual(pref);
  });

  it.each(fams.flatMap((f) => modes.map((m): [KeyFamily, Mode] => [f, m])))(
    "result is in family %s and mode %s",
    (fam, mode) => {
      const other: Mode = mode === "major" ? "minor" : "major";
      const prefs: (Key | undefined)[] = [
        undefined,
        { tonic: "F#", mode },
        { tonic: "C", mode: other },
      ];
      for (const pref of prefs) {
        for (let seed = 0; seed < 50; seed++) {
          const k = keyForFamily(fam, mode, pref, createRng(seed));
          if (pref?.mode === mode && keyFamily(pref) === fam) expect(k).toEqual(pref);
          else {
            expect(k.mode).toBe(mode);
            expect(keyFamily(k)).toBe(fam);
          }
        }
      }
    },
  );

  it("is deterministic per seed", () => {
    expect(keyForFamily("C", "major", undefined, createRng(7))).toEqual(
      keyForFamily("C", "major", undefined, createRng(7)),
    );
  });

  it("cMajorFirst forces C major / A minor in family A only", () => {
    const opts = { cMajorFirst: true };
    const pref: Key = { tonic: "G", mode: "major" };
    expect(keyForFamily("A", "major", pref, createRng(1), opts)).toEqual({
      tonic: "C",
      mode: "major",
    });
    expect(keyForFamily("A", "minor", undefined, createRng(1), opts)).toEqual({
      tonic: "A",
      mode: "minor",
    });
    expect(keyFamily(keyForFamily("B", "major", undefined, createRng(1), opts))).toBe("B");
  });
});

describe("familyOfParams", () => {
  it("reads a valid family", () => {
    expect(familyOfParams({ fam: "B" })).toBe("B");
    expect(familyOfParams({ fam: "Z" })).toBeUndefined();
    expect(familyOfParams({})).toBeUndefined();
  });
});
