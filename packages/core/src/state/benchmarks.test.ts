import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { eventFixtures } from "../events/fixtures/index.js";
import type { BenchmarkRecorded } from "../events/learning.js";
import { applyEvent, foldEvents, initialState } from "./reduce.js";
import { makeSnapshot, restoreSnapshot } from "./snapshot.js";
import { FIXTURE_GRAPH, T0, ctx } from "./test-helpers.js";

const C = ctx(FIXTURE_GRAPH);
const fixture = eventFixtures["benchmark.recorded"] as BenchmarkRecorded;

const MONTHS = ["2026-01", "2026-02", "2026-03"];
const PIECES = ["piece.ode-to-joy", "piece.twinkle-twinkle"];

/** Benchmark `n` (distinct ids) for `month` at time `at`. */
function recorded(n: number, month: string, at: number, pieceId = PIECES[0]): BenchmarkRecorded {
  const benchmarkId = `01JBX0000000000000000BM${String(n).padStart(3, "0")}`;
  return {
    ...fixture,
    id: `01JBX0000000000000000E${String(n).padStart(4, "0")}`,
    at,
    month,
    benchmarkId,
    pieceId: pieceId ?? fixture.pieceId,
    blobKey: `benchmark-${benchmarkId}.webm`,
  };
}

const shuffle = <T>(xs: readonly T[], keys: readonly number[]): T[] =>
  xs
    .map((x, i) => ({ x, k: keys[i] ?? 0 }))
    .sort((a, b) => a.k - b.k)
    .map((e) => e.x);

describe("benchmarks state", () => {
  it("starts empty and keeps one record per month", () => {
    expect(initialState(C).benchmarks).toEqual({});
    const e = recorded(1, "2026-01", T0);
    const state = foldEvents([e, recorded(2, "2026-02", T0 + 1000)], C);
    expect(Object.keys(state.benchmarks).sort()).toEqual(["2026-01", "2026-02"]);
    expect(state.benchmarks["2026-01"]).toEqual({
      benchmarkId: e.benchmarkId,
      pieceId: e.pieceId,
      month: "2026-01",
      blobKey: e.blobKey,
      contentType: "audio/webm",
      durationMs: e.durationMs,
      sizeBytes: e.sizeBytes,
      at: T0,
      eventId: e.id,
    });
  });

  it("keeps the latest take of a month, in either order", () => {
    const first = recorded(1, "2026-01", T0, PIECES[0]);
    const again = recorded(2, "2026-01", T0 + 5000, PIECES[1]);
    for (const events of [
      [first, again],
      [again, first],
    ]) {
      const state = foldEvents(events, C);
      expect(state.benchmarks["2026-01"]?.benchmarkId).toBe(again.benchmarkId);
      expect(state.benchmarks["2026-01"]?.pieceId).toBe(PIECES[1]);
    }
    // A stale event applied after the newer one changes nothing.
    const newer = applyEvent(initialState(C), again, C);
    expect(applyEvent(newer, first, C).benchmarks).toEqual(newer.benchmarks);
    // Same time: the larger event id wins.
    const tieLow = recorded(3, "2026-01", T0 + 9000);
    const tieHigh = recorded(4, "2026-01", T0 + 9000);
    expect(foldEvents([tieHigh, tieLow], C).benchmarks["2026-01"]?.benchmarkId).toBe(
      tieHigh.benchmarkId,
    );
  });

  it("does not depend on event order (fast-check)", () => {
    const eventArb = fc.array(
      fc.record({
        month: fc.constantFrom(...MONTHS),
        piece: fc.constantFrom(...PIECES),
        dt: fc.integer({ min: 0, max: 5 }),
      }),
      { minLength: 1, maxLength: 12 },
    );
    fc.assert(
      fc.property(
        eventArb.chain((specs) =>
          fc.tuple(
            fc.constant(specs),
            fc.array(fc.integer(), { minLength: specs.length, maxLength: specs.length }),
          ),
        ),
        ([specs, keys]) => {
          // Small time steps make ties likely, so the id tie-break is exercised too.
          const events = specs.map((s, i) => recorded(i + 1, s.month, T0 + s.dt * 1000, s.piece));
          const a = foldEvents(events, C).benchmarks;
          const b = foldEvents(shuffle(events, keys), C).benchmarks;
          expect(b).toEqual(a);
          // Each month holds its latest event by (at, id).
          for (const month of MONTHS) {
            const latest = events
              .filter((e) => e.month === month)
              .sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : 1))
              .at(-1);
            expect(a[month]?.eventId).toBe(latest?.id);
          }
          // Folding one at a time gives the same state.
          let s = initialState(C);
          for (const e of shuffle(events, keys)) s = applyEvent(s, e, C);
          expect(s.benchmarks).toEqual(a);
        },
      ),
    );
  });

  it("survives a snapshot round trip", () => {
    const state = foldEvents([recorded(1, "2026-01", T0)], C);
    const restored = restoreSnapshot(makeSnapshot(state, "fixture-1"), "fixture-1");
    expect(restored?.benchmarks).toEqual(state.benchmarks);
  });
});
