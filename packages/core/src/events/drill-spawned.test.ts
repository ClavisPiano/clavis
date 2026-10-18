import { describe, expect, it } from "vitest";
import { eventFixtures } from "./fixtures/index.js";
import { eventRegistry, parseEvent } from "./schema.js";

type Obj = Record<string, unknown>;
const base = eventFixtures["drill.spawned"] as Obj;
const code = (patch: Obj): string => {
  const r = parseEvent({ ...base, ...patch });
  return r.ok ? "ok" : r.error.code;
};

const NODE = "hands.lh.triads.root";

describe("drill.spawned v1", () => {
  it("is registered at v1 and its fixture parses unchanged", () => {
    expect(Object.keys(eventRegistry["drill.spawned"].versions)).toEqual(["1"]);
    expect(parseEvent(base)).toEqual({ ok: true, event: base });
  });

  it.each<[string, Obj, string]>([
    [
      "a hands-together drill",
      {
        nodeId: "hands.coord.basic",
        sourceItemId: "hands.coord.basic|fam=B|mel=2|prog=I-V-vi-IV",
        itemIds: ["hands.coord.basic|drill=V-vi|fam=B"],
      },
      "ok",
    ],
    [
      "three drills",
      {
        itemIds: [
          `${NODE}|drill=IV-V|fam=A`,
          `${NODE}|drill=V-I|fam=A`,
          `${NODE}|drill=I-vi|fam=A`,
        ],
      },
      "ok",
    ],
    [
      "four drills",
      {
        itemIds: [
          `${NODE}|drill=IV-V|fam=A`,
          `${NODE}|drill=V-I|fam=A`,
          `${NODE}|drill=I-vi|fam=A`,
          `${NODE}|drill=vi-IV|fam=A`,
        ],
      },
      "invalid",
    ],
    ["no drills", { itemIds: [] }, "invalid"],
    [
      "the same drill twice",
      { itemIds: [`${NODE}|drill=IV-V|fam=A`, `${NODE}|drill=IV-V|fam=A`] },
      "invalid",
    ],
    ["a drill of another node", { itemIds: ["hands.coord.basic|drill=IV-V|fam=A"] }, "invalid"],
    ["not a drill", { itemIds: [`${NODE}|fam=A|prog=IV-V-IV-V`] }, "invalid"],
    ["one chord twice", { itemIds: [`${NODE}|drill=V-V|fam=A`] }, "invalid"],
    ["params out of order", { itemIds: [`${NODE}|fam=A|drill=IV-V`] }, "invalid"],
    ["no key family", { itemIds: [`${NODE}|drill=IV-V`] }, "invalid"],
    [
      "a source from another node",
      { sourceItemId: "hands.coord.basic|fam=A|mel=1|prog=I-IV-V-I" },
      "invalid",
    ],
    ["a drill as the source", { sourceItemId: `${NODE}|drill=I-IV|fam=A` }, "invalid"],
    ["not a ULID session", { sessionId: "s1" }, "invalid"],
    ["an unknown key", { userId: "u1" }, "invalid"],
    ["v2", { v: 2 }, "unknown_version"],
  ])("%s", (_name, patch, expected) => {
    expect(code(patch)).toBe(expected);
  });
});
