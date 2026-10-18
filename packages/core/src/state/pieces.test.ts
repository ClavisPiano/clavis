import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Snapshot } from "../events/store.js";
import type { LearningEvent } from "../events/schema.js";
import { compareEvents } from "../events/validate.js";
import type { GeneratorInfo, SkillGraph } from "../graph/schema.js";
import { applyEvent, foldEvents, REDUCER_VERSION } from "./reduce.js";
import { makeSnapshot, restoreSnapshot } from "./snapshot.js";
import { Builder, FIXTURE_GRAPH, T0, ctx } from "./test-helpers.js";

const PIECES_NODE = {
  id: "apply.pieces",
  strand: "APPLY" as const,
  title: "Pieces",
  prerequisites: [],
  itemGenerators: ["pieceLine" as const],
  params: {},
  mastery: { minAccuracy: 0.8, windowAttempts: 5, distinctSessions: 2 },
  keyDependent: false,
};
const PIECE_GENERATOR: GeneratorInfo = {
  id: "pieceLine",
  implemented: true,
  seedDurationSec: 25,
  awayEligible: false,
  requires: ["keys", "notation"],
};
const EAR_NODE = {
  ...PIECES_NODE,
  id: "apply.piece-ear",
  title: "Pieces by ear",
  itemGenerators: ["pieceEar" as const],
};
const EAR_GENERATOR: GeneratorInfo = { ...PIECE_GENERATOR, id: "pieceEar", seedDurationSec: 60 };
const HANDS_NODE = {
  ...PIECES_NODE,
  id: "apply.pieces-hands",
  title: "Pieces, hands together",
  itemGenerators: ["pieceHands" as const],
};
const HANDS_GENERATOR: GeneratorInfo = {
  ...PIECE_GENERATOR,
  id: "pieceHands",
  seedDurationSec: 40,
  requires: ["keys", "polyphonic", "notation"],
};
const GRAPH: SkillGraph = {
  ...FIXTURE_GRAPH,
  generators: [...FIXTURE_GRAPH.generators, PIECE_GENERATOR, EAR_GENERATOR, HANDS_GENERATOR],
  nodes: [...FIXTURE_GRAPH.nodes, PIECES_NODE, EAR_NODE, HANDS_NODE],
};
const C = ctx(GRAPH);
const fold = (events: readonly LearningEvent[]) => foldEvents(events, C);

const HCB = "piece.hot-cross-buns";
const ODE = "piece.ode-to-joy";

/** A session on one device with phrase attempts, then optionally a run. */
function session(
  b: Builder,
  n: number,
  at: number,
  phrases: [string, number, boolean][],
  o: { practice?: boolean } = {},
): LearningEvent[] {
  const sid = b.sessionId(n);
  const out: LearningEvent[] = [b.start(at, sid, o)];
  let t = at + 1000;
  for (const [piece, phrase, correct] of phrases) {
    out.push(...b.phrase(t, sid, piece, phrase, { correct }));
    t += 20_000;
  }
  out.push(b.end(t, sid));
  return out;
}

describe("piece progress (MP)", () => {
  it("starts empty", () => {
    expect(fold([]).pieces).toEqual({});
  });

  it("phrase attempts count per phrase, with the latest result", () => {
    const b = new Builder();
    const s = fold(
      session(b, 1, T0, [
        [HCB, 1, false],
        [HCB, 1, true],
        [HCB, 2, true],
        [ODE, 1, false],
      ]),
    );
    const hcb = s.pieces[HCB];
    expect(hcb?.runs).toBe(0);
    expect(hcb?.completedAt).toBeUndefined();
    expect(hcb?.phrases["1"]).toMatchObject({ attempts: 2, correct: 1, lastCorrect: true });
    expect(hcb?.phrases["2"]).toMatchObject({ attempts: 1, correct: 1, lastCorrect: true });
    expect(s.pieces[ODE]?.phrases["1"]).toMatchObject({
      attempts: 1,
      correct: 0,
      lastCorrect: false,
    });
  });

  it("the latest attempt decides lastCorrect and lastAt, whatever order events arrive in", () => {
    const b = new Builder();
    const events = session(b, 1, T0, [
      [HCB, 1, true],
      [HCB, 1, false],
    ]);
    const forward = fold(events);
    const backward = fold([...events].reverse());
    expect(backward).toStrictEqual(forward);
    expect(forward.pieces[HCB]?.phrases["1"]?.lastCorrect).toBe(false);
  });

  it("phrase attempts also feed the pieces node: attempts and a card per phrase item", () => {
    const b = new Builder();
    const s = fold(session(b, 1, T0, [[HCB, 1, true]]));
    expect(s.attempts["apply.pieces"]).toHaveLength(1);
    const card = s.cards[`apply.pieces|phrase=1|piece=${HCB}`];
    expect(card?.nodeId).toBe("apply.pieces");
    expect(card?.reps).toBe(1);
    expect(s.warnings).toBe(0);
  });

  it("phrases played by ear feed their own node and never count as reading the phrase", () => {
    const b = new Builder();
    const sid = b.sessionId(1);
    const s = fold([
      b.start(T0, sid),
      ...b.phrase(T0 + 1000, sid, HCB, 1, { ear: true }),
      b.end(T0 + 60_000, sid),
    ]);
    expect(s.pieces).toEqual({});
    expect(s.attempts["apply.piece-ear"]).toHaveLength(1);
    expect(s.cards[`apply.piece-ear|phrase=1|piece=${HCB}`]?.nodeId).toBe("apply.piece-ear");
    expect(s.warnings).toBe(0);
  });

  it("hands-together phrases (T5.6) are progress on the hands piece, under its own id", () => {
    const b = new Builder();
    const sid = b.sessionId(1);
    const HANDS = `${ODE}-hands`;
    const s = fold([
      b.start(T0, sid),
      ...b.phrase(T0 + 1000, sid, HANDS, 2, { hands: true, correct: false }),
      ...b.phrase(T0 + 30_000, sid, HANDS, 2, { hands: true }),
      b.pieceCompleted(T0 + 60_000, sid, HANDS, 4, 4),
      b.end(T0 + 90_000, sid),
    ]);
    expect(Object.keys(s.pieces)).toEqual([HANDS]);
    expect(s.pieces[HANDS]?.phrases["2"]).toMatchObject({
      attempts: 2,
      correct: 1,
      lastCorrect: true,
    });
    expect(s.pieces[HANDS]?.completedAt).toBe(T0 + 60_000);
    expect(s.cards[`apply.pieces-hands|phrase=2|piece=${HANDS}`]?.nodeId).toBe(
      "apply.pieces-hands",
    );
    expect(s.attempts["apply.pieces"]).toBeUndefined();
    expect(s.warnings).toBe(0);
  });

  it("a practice session counts as evidence for the piece but writes no card", () => {
    const b = new Builder();
    const s = fold(session(b, 1, T0, [[HCB, 1, true]], { practice: true }));
    expect(s.pieces[HCB]?.phrases["1"]?.attempts).toBe(1);
    expect(s.cards).toEqual({});
  });

  it("piece.completed counts runs; only an all-correct run completes the piece", () => {
    const b = new Builder();
    const sid = b.sessionId(1);
    const s1 = fold([b.start(T0, sid), b.pieceCompleted(T0 + 1000, sid, HCB, 4, 3)]);
    expect(s1.pieces[HCB]).toMatchObject({ runs: 1, lastRunAt: T0 + 1000, phrases: {} });
    expect(s1.pieces[HCB]?.completedAt).toBeUndefined();

    const s2 = fold([
      b.start(T0, sid),
      b.pieceCompleted(T0 + 1000, sid, HCB, 4, 3),
      b.pieceCompleted(T0 + 2000, sid, HCB, 4, 4),
      b.pieceCompleted(T0 + 3000, sid, HCB, 4, 4),
    ]);
    expect(s2.pieces[HCB]).toMatchObject({ runs: 3, lastRunAt: T0 + 3000, completedAt: T0 + 2000 });
  });

  it("ignores a presentation that does not name a phrase, and other generators' piece fields", () => {
    const b = new Builder();
    const sid = b.sessionId(1);
    const bad = [
      { piece: HCB },
      { piece: HCB, phrase: 0 },
      { piece: HCB, phrase: 1.5 },
      { piece: 7, phrase: 1 },
      { phrase: 1 },
    ];
    const events = [
      b.start(T0, sid),
      ...bad.flatMap((presentation, i) =>
        b.phrase(T0 + 1000 + i * 20_000, sid, HCB, 1, { presentation }),
      ),
      // An ear item that happens to carry piece fields is not a piece phrase.
      ...b.item(T0 + 500_000, sid, "n1", "n1:0", { presentation: { piece: HCB, phrase: "1" } }),
    ];
    const s = fold(events);
    expect(s.pieces).toEqual({});
    expect(s.attempts["apply.pieces"]).toHaveLength(bad.length);
  });

  it("a snapshot from the previous reducer version is discarded", () => {
    const state = fold([]);
    const snap = makeSnapshot(state, GRAPH.contentVersion);
    expect(snap.reducerVersion).toBe(REDUCER_VERSION);
    expect(restoreSnapshot(snap, GRAPH.contentVersion)).toBeDefined();
    const old: Snapshot = { ...snap, reducerVersion: REDUCER_VERSION - 1 };
    expect(restoreSnapshot(old, GRAPH.contentVersion)).toBeUndefined();
  });
});

/* ---------- properties ---------- */

const planArb = fc.array(
  fc.record({
    piece: fc.constantFrom(HCB, ODE),
    phrase: fc.integer({ min: 1, max: 4 }),
    correct: fc.boolean(),
  }),
  { minLength: 1, maxLength: 8 },
);
const runArb = fc.array(
  fc.record({
    piece: fc.constantFrom(HCB, ODE),
    correct: fc.integer({ min: 0, max: 4 }),
  }),
  { maxLength: 3 },
);

function device(
  tag: string,
  plan: { piece: string; phrase: number; correct: boolean }[],
  runs: { piece: string; correct: number }[],
): LearningEvent[] {
  const b = new Builder(`dev-${tag}`, tag);
  const sid = b.sessionId(1);
  const out: LearningEvent[] = [b.start(T0, sid)];
  let t = T0 + 1000;
  for (const p of plan) {
    out.push(...b.phrase(t, sid, p.piece, p.phrase, { correct: p.correct }));
    t += 15_000;
  }
  for (const r of runs) {
    out.push(b.pieceCompleted(t, sid, r.piece, 4, r.correct));
    t += 1000;
  }
  out.push(b.end(t, sid));
  return out;
}

const shuffled = <T>(xs: readonly T[], keys: readonly number[]): T[] =>
  xs
    .map((x, i) => ({ x, k: keys[i % keys.length] ?? 0, i }))
    .sort((p, q) => p.k - q.k || p.i - q.i)
    .map((p) => p.x);

describe("piece progress properties", () => {
  const twoDevices = fc.tuple(fc.tuple(planArb, runArb), fc.tuple(planArb, runArb));

  it("is independent of the order events arrive in", () => {
    fc.assert(
      fc.property(
        twoDevices,
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 40 }),
        ([[pa, ra], [pb, rb]], keys) => {
          const all = [...device("A", pa, ra), ...device("B", pb, rb)];
          expect(fold(shuffled(all, keys))).toStrictEqual(fold([...all].sort(compareEvents)));
        },
      ),
      { numRuns: 100 },
    );
  });

  it("replaying events twice changes nothing", () => {
    fc.assert(
      fc.property(twoDevices, ([[pa, ra], [pb, rb]]) => {
        const all = [...device("A", pa, ra), ...device("B", pb, rb)];
        expect(fold([...all, ...all])).toStrictEqual(fold(all));
      }),
      { numRuns: 60 },
    );
  });

  it("applying events one at a time equals one fold, and the state survives JSON", () => {
    fc.assert(
      fc.property(twoDevices, ([[pa, ra], [pb, rb]]) => {
        const sorted = [...device("A", pa, ra), ...device("B", pb, rb)].sort(compareEvents);
        let s = fold([]);
        for (const e of sorted) s = applyEvent(s, e, C);
        const full = fold(sorted);
        expect(s).toStrictEqual(full);
        expect(JSON.parse(JSON.stringify(full))).toStrictEqual(full);
      }),
      { numRuns: 40 },
    );
  });

  it("per phrase, correct never exceeds attempts, and a completed piece has a full-correct run", () => {
    fc.assert(
      fc.property(twoDevices, ([[pa, ra], [pb, rb]]) => {
        const s = fold([...device("A", pa, ra), ...device("B", pb, rb)]);
        for (const piece of Object.values(s.pieces)) {
          for (const ph of Object.values(piece.phrases)) {
            expect(ph.correct).toBeLessThanOrEqual(ph.attempts);
            expect(ph.attempts).toBeGreaterThan(0);
          }
          if (piece.completedAt !== undefined) expect(piece.runs).toBeGreaterThan(0);
        }
        const fullRuns = [...ra, ...rb].filter((r) => r.correct === 4);
        for (const id of [HCB, ODE]) {
          const had = fullRuns.some((r) => r.piece === id);
          expect(s.pieces[id]?.completedAt !== undefined).toBe(had);
        }
      }),
      { numRuns: 100 },
    );
  });
});
