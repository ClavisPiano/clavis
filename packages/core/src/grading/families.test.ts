import { describe, expect, it } from "vitest";
import type { NodeState } from "../graph/schema.js";
import type { KeyFamily } from "../theory/keys.js";
import { combineFamilyStates } from "./families.js";

type Row = [Partial<Record<KeyFamily, NodeState>>, NodeState];

const rows: Row[] = [
  [{}, "available"],
  [{ A: "locked" }, "locked"],
  [{ A: "available" }, "available"],
  [{ A: "learning" }, "learning"],
  [{ A: "fluent" }, "fluent"],
  [{ A: "mastered", B: "fluent" }, "mastered"],
  [{ A: "mastered", B: "mastered" }, "mastered"],
  [{ A: "mastered", B: "learning" }, "fluent"],
  [{ A: "mastered" }, "fluent"],
  [{ A: "fluent", B: "mastered" }, "fluent"],
  [{ A: "available", B: "learning" }, "learning"],
  [{ B: "fluent" }, "learning"],
  [{ C: "learning" }, "learning"],
  [{ C: "mastered" }, "learning"],
  [{ A: "mastered", B: "available", C: "mastered" }, "fluent"],
  [{ A: "locked", C: "fluent" }, "learning"],
];

describe("combineFamilyStates", () => {
  it.each(rows)("%j -> %s", (input, expected) => {
    expect(combineFamilyStates(input)).toBe(expected);
  });
});
