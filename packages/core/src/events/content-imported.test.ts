import { describe, expect, it } from "vitest";
import { eventFixtures } from "./fixtures/index.js";
import { ContentImportedV1 } from "./learning.js";
import { eventRegistry, parseEvent } from "./schema.js";

type Obj = Record<string, unknown>;
const base = eventFixtures["content.imported"] as Obj;
const code = (input: unknown): string => {
  const r = parseEvent(input);
  return r.ok ? "ok" : r.error.code;
};
const score = base.score as {
  staves: { clef: string; lines: number; measures: Obj[][] }[];
  key: unknown;
  meter: unknown;
};
const withScore = (patch: Obj): Obj => ({ ...base, score: { ...score, ...patch } });

describe("content.imported v1", () => {
  it("is registered at v1 with an identity upcast", () => {
    const entry = eventRegistry["content.imported"];
    expect(Object.keys(entry.versions)).toEqual(["1"]);
    expect(entry.upcast(base, 1)).toBe(base);
  });

  it("accepts the fixture and both sources", () => {
    expect(code(base)).toBe("ok");
    expect(code({ ...base, source: "mxl" })).toBe("ok");
    expect(ContentImportedV1.safeParse(base).success).toBe(true);
  });

  it.each<[string, Obj]>([
    ["an unknown source", { source: "midi" }],
    ["an empty title", { title: "" }],
    ["a title over 120 characters", { title: "x".repeat(121) }],
    ["a library piece id", { pieceId: "piece.hot-cross-buns" }],
    ["a user id with the wrong length", { pieceId: "piece.user-abc" }],
    ["an upper case user id", { pieceId: "piece.user-01JBX00000000000000000A010" }],
    ["difficulty 0", { difficulty: 0 }],
    ["difficulty 11", { difficulty: 11 }],
    ["a negative part index", { partIndex: -1 }],
    ["staff 0", { staff: 0 }],
    ["no phrases", { phrases: [] }],
    ["an unknown key", { userId: "u1" }],
  ])("rejects %s", (_name, patch) => {
    expect(code({ ...base, ...patch })).toBe("invalid");
  });

  it("rejects an invalid ScoreSpec", () => {
    const badDuration = JSON.parse(JSON.stringify(score)) as typeof score;
    (badDuration.staves[0]?.measures[0]?.[0]?.duration as Obj).value = 3;
    expect(code({ ...base, score: badDuration })).toBe("invalid");
    expect(code({ ...base, score: { staves: [], key: null, meter: null } })).toBe("invalid");
    expect(code({ ...base, score: "C D E" })).toBe("invalid");
  });

  it("rejects a score that is not a valid piece", () => {
    const staff = score.staves[0];
    if (staff === undefined) throw new Error("fixture has no staff");
    const [first, second] = staff.measures;
    // A short measure, as a pickup bar is.
    const pickup = withScore({
      staves: [{ ...staff, measures: [first?.slice(0, 2) ?? [], second ?? []] }],
    });
    expect(code({ ...pickup })).toBe("invalid");
    // No key, no meter.
    expect(code(withScore({ key: null }))).toBe("invalid");
    expect(code(withScore({ meter: null }))).toBe("invalid");
    // Phrases that do not tile the measures.
    expect(code({ ...base, phrases: [{ firstMeasure: 1, lastMeasure: 1 }] })).toBe("invalid");
    expect(code({ ...base, phrases: [{ firstMeasure: 2, lastMeasure: 2 }] })).toBe("invalid");
  });

  it("rejects a chord, since a piece is one line", () => {
    const staff = score.staves[0];
    const note = staff?.measures[0]?.[0];
    if (staff === undefined || note === undefined) throw new Error("fixture has no note");
    const chord = {
      ...note,
      pitches: [...(note.pitches as Obj[]), { step: "E", alter: 0, octave: 4 }],
    };
    const measures = [[chord, ...(staff.measures[0]?.slice(1) ?? [])], staff.measures[1] ?? []];
    expect(code(withScore({ staves: [{ ...staff, measures }] }))).toBe("invalid");
  });
});
