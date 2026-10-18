import { describe, expect, it } from "vitest";
import type { NodeState } from "../graph/schema.js";
import type { Piece } from "../pieces/schema.js";
import type { BenchmarkRecord, LearnerState } from "../state/types.js";
import {
  benchmarkBlobKey,
  benchmarkMonth,
  benchmarkOptions,
  benchmarksByPiece,
  defaultComparison,
  needsBenchmark,
} from "./benchmark.js";

const score = {
  staves: [{ clef: "treble" as const, notes: [] }],
  key: null,
  meter: null,
};

/** A library piece `id` of `difficulty` that needs node `need`. */
const piece = (id: string, difficulty: number, need: string): Piece =>
  ({
    id: `piece.${id}`,
    title: id,
    source: "Traditional",
    score,
    phrases: [{ firstMeasure: 1, lastMeasure: 1 }],
    requiredNodeIds: [need],
    difficulty,
  }) as unknown as Piece;

// Library order, easiest first. Each piece needs its own node, so the table can unlock any set.
const LIBRARY: Piece[] = [
  piece("a", 1, "na"),
  piece("b", 2, "nb"),
  piece("c", 3, "nc"),
  piece("d", 3, "nd"),
  piece("e", 4, "ne"),
  piece("f", 5, "nf"),
  piece("g", 6, "ng"),
];

const learner = (unlocked: string[]): Pick<LearnerState, "nodes"> => ({
  nodes: Object.fromEntries(
    LIBRARY.map((p) => {
      const id = p.id.slice("piece.".length);
      const state: NodeState = unlocked.includes(id) ? "fluent" : "learning";
      return [`n${id}`, { state }];
    }),
  ),
});

const ids = (opts: ReturnType<typeof benchmarkOptions>): string =>
  opts.map((o) => `${o.piece.id.slice(6)}${o.unlocked ? "" : "*"}`).join(" ");

describe("benchmarkOptions", () => {
  // `*` marks a locked padding piece.
  it.each<[string, string[], string]>([
    ["nothing unlocked: the three easiest", [], "a* b* c*"],
    ["one unlocked: padded with the two easiest others", ["f"], "a* b* f"],
    ["two unlocked: padded with the easiest other", ["a", "g"], "a b* g"],
    ["three unlocked: no padding", ["a", "b", "c"], "a b c"],
    ["four unlocked: all four", ["a", "c", "e", "g"], "a c e g"],
    ["five unlocked: the four hardest", ["a", "b", "c", "e", "f"], "b c e f"],
    ["all unlocked: the four hardest", ["a", "b", "c", "d", "e", "f", "g"], "d e f g"],
    ["a difficulty tie goes to the later piece", ["c", "d", "e", "f", "g"], "d e f g"],
    [
      "five unlocked with a tie inside: the easiest is dropped",
      ["a", "c", "d", "f", "g"],
      "c d f g",
    ],
  ])("%s", (_name, unlocked, expected) => {
    expect(ids(benchmarkOptions(LIBRARY, learner(unlocked)))).toBe(expected);
  });

  it("never offers an imported piece", () => {
    const own: Piece = { ...piece("x", 9, "na"), id: "piece.user-01jbx00000000000000000bm01" };
    const opts = benchmarkOptions([own, ...LIBRARY], learner(["a"]));
    expect(opts.map((o) => o.piece.id)).not.toContain(own.id);
    expect(ids(opts)).toBe("a b* c*");
  });

  it("offers fewer than three only when the library is that small", () => {
    expect(ids(benchmarkOptions(LIBRARY.slice(0, 2), learner([])))).toBe("a* b*");
    expect(benchmarkOptions([], learner([]))).toEqual([]);
  });
});

describe("benchmarkMonth", () => {
  const at = (iso: string) => Date.parse(iso);
  it.each<[string, number, string]>([
    ["2026-10-17T12:00:00Z", 0, "2026-10"],
    // Sydney (+600): already November locally.
    ["2026-10-31T20:00:00Z", 600, "2026-11"],
    // Los Angeles (-420): still October locally.
    ["2026-11-01T05:00:00Z", -420, "2026-10"],
    // Before the 04:00 rollover on the first, the learner day is still the last of the month.
    ["2026-11-01T03:00:00Z", 0, "2026-10"],
    ["2026-11-01T04:00:00Z", 0, "2026-11"],
    ["2027-01-01T05:00:00Z", 0, "2027-01"],
  ])("%s at %i min is %s", (iso, tz, month) => {
    expect(benchmarkMonth(at(iso), tz)).toBe(month);
  });
});

const rec = (month: string, pieceId: string, n: number): BenchmarkRecord => ({
  benchmarkId: `01JBX00000000000000000BM${String(n).padStart(2, "0")}`,
  pieceId,
  month,
  blobKey: `benchmark-01JBX00000000000000000BM${String(n).padStart(2, "0")}.webm`,
  contentType: "audio/webm",
  durationMs: 1000,
  sizeBytes: 10,
  at: n,
  eventId: `01JBX00000000000000000E0${String(n).padStart(2, "0")}`,
});

describe("listing", () => {
  const benchmarks = {
    "2026-07": rec("2026-07", "piece.a", 1),
    "2026-08": rec("2026-08", "piece.b", 2),
    "2026-09": rec("2026-09", "piece.a", 3),
    "2026-10": rec("2026-10", "piece.a", 4),
  };

  it("prompts only while the month has none", () => {
    expect(needsBenchmark({ benchmarks }, "2026-10")).toBe(false);
    expect(needsBenchmark({ benchmarks }, "2026-11")).toBe(true);
    expect(needsBenchmark({ benchmarks: {} }, "2026-10")).toBe(true);
  });

  it("groups by piece, newest first", () => {
    const groups = benchmarksByPiece({ benchmarks });
    expect(groups.map((g) => [g.pieceId, g.benchmarks.map((b) => b.month)])).toEqual([
      ["piece.a", ["2026-10", "2026-09", "2026-07"]],
      ["piece.b", ["2026-08"]],
    ]);
  });

  it("compares the newest take with the oldest by default", () => {
    const [a, b] = benchmarksByPiece({ benchmarks });
    expect(defaultComparison(a?.benchmarks ?? [])).toEqual({
      latest: benchmarks["2026-10"],
      earlier: benchmarks["2026-07"],
    });
    expect(defaultComparison(b?.benchmarks ?? [])).toEqual({
      latest: benchmarks["2026-08"],
      earlier: undefined,
    });
  });

  it("names the blob after the benchmark id with the type's extension", () => {
    const id = "01JBX00000000000000000BM01";
    expect(benchmarkBlobKey(id, "audio/webm")).toBe(`benchmark-${id}.webm`);
    expect(benchmarkBlobKey(id, "audio/mp4")).toBe(`benchmark-${id}.m4a`);
    expect(benchmarkBlobKey(id, "audio/ogg")).toBe(`benchmark-${id}.ogg`);
  });
});
