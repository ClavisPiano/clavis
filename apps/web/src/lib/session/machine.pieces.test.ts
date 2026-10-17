import { loadGraph, loadPieces } from "@clavis/content";
import {
  GENERATORS,
  composePieceRun,
  composeSession,
  createPieceEar,
  createPieceLine,
  type ComposeInput,
  type GenerateContext,
  type ItemInstance,
  type LearningEvent,
  type PlannedItem,
  type SkillGraph,
} from "@clavis/core";
import { describe, expect, it } from "vitest";
import { SessionMachine, type SessionState } from "./machine";
import {
  FakeNotation,
  logOf,
  makeHarness,
  noteAt,
  playCorrect,
  T0,
  type Harness,
} from "./test-harness";

/* Piece phrases (MP, TP.4): the Apply block, graded as a line (pitch first, then rhythm), and the
   whole-piece run that writes `piece.completed`. Real graph, real library, real composer and
   generator; only the notation port is a fake. */

const HCB = "piece.hot-cross-buns";

const NODE = "apply.pieces";

const shipped = loadGraph();
/** The shipped graph with `pieceLine` switched on, as the enabling PR will leave it. */
const graph: SkillGraph = {
  ...shipped,
  generators: shipped.generators.map((g) =>
    g.id === "pieceLine" ? { ...g, implemented: true } : g,
  ),
};
const pieces = loadPieces();
const generators = {
  ...GENERATORS,
  pieceLine: createPieceLine(pieces),
  pieceEar: createPieceEar(pieces),
};

const id = (n: number): string => `01JBX0000000000000000${String(n).padStart(5, "0")}`;

/** A learner with the treble reading chain past learning, so the first piece is unlocked. */
function trebleHistory(): LearningEvent[] {
  return [
    {
      deviceId: "seed-device",
      v: 1,
      id: id(1),
      at: T0 - 3 * 86_400_000,
      type: "placement.completed",
      placementId: id(2),
      results: {
        "read.treble.landmarks": "fluent",
        "read.treble.steps": "fluent",
        "read.treble.skips": "fluent",
      },
    },
  ] as unknown as LearningEvent[];
}

interface Rig {
  h: Harness;
  machine: SessionMachine;
  notation: FakeNotation;
}

/** `run` plays the whole piece; otherwise the plan is the Apply block of a composed session. */
async function makeRig(opts: { run?: string; notation?: boolean } = {}): Promise<Rig> {
  const h = await makeHarness({ budgetSec: 600, graph, history: trebleHistory() });
  const notation = new FakeNotation(h.clock);
  const compose = (input: ComposeInput) => {
    if (opts.run !== undefined) {
      return composePieceRun({
        state: input.state,
        graph: input.graph,
        pieces,
        pieceId: opts.run,
        now: input.now,
        tzOffsetMin: input.tzOffsetMin,
        generators,
      });
    }
    const plan = composeSession({ ...input, pieces, generators });
    return {
      ...plan,
      orient: null,
      introductions: [],
      blocks: { ear: [], read: [], apply: plan.blocks.apply },
    };
  };
  const generate = (item: PlannedItem, ctx: GenerateContext): ItemInstance => {
    const node = h.graph.nodes.find((n) => n.id === item.nodeId);
    const gen = generators[item.generator];
    if (!node || !gen) throw new Error(`cannot generate ${item.generator}`);
    return gen.generate(node, item.params, ctx);
  };
  const machine = new SessionMachine({
    ...h.deps,
    compose,
    generate,
    ...(opts.notation === false ? {} : { notation }),
  });
  return { h, machine, notation };
}

async function until(
  r: Rig,
  pred: (s: SessionState) => boolean,
  maxMs = 60_000,
): Promise<SessionState> {
  for (let t = 0; t < maxMs && !pred(r.machine.state); t += 50) await r.h.advance(50);
  if (!pred(r.machine.state)) {
    throw new Error(`condition not reached, stuck in ${JSON.stringify(r.machine.state)}`);
  }
  return r.machine.state;
}

const listening = (s: SessionState): boolean => s.kind === "listening";
const feedback = (s: SessionState): boolean => s.kind === "feedback";
const summary = (s: SessionState): boolean => s.kind === "summary";

/** Play the current phrase right, or with `wrongAt` set to a note index, one note a semitone off. */
async function play(r: Rig, wrongAt?: number): Promise<void> {
  await until(r, listening);
  const expected = r.machine.debug().expected;
  const line = expected?.play;
  if (line?.kind !== "line") throw new Error("not a line item");
  const start = (r.machine.debug().stimulusEndMs ?? 0) + 700;
  if (wrongAt === undefined) {
    playCorrect(r.h.input, expected ?? { responseWindowMs: 1 }, start);
  } else {
    const beatMs = 60000 / line.tempoBpm;
    line.midi.forEach((m, i) => {
      const onset = start + (line.onsetsBeats[i] ?? 0) * beatMs;
      r.h.input.emitNote(noteAt(i === wrongAt ? m + 1 : m, onset, "mic"));
    });
  }
  await until(r, feedback);
}

function ofType<T extends LearningEvent["type"]>(
  events: LearningEvent[],
  type: T,
): Extract<LearningEvent, { type: T }>[] {
  return events.filter((e): e is Extract<LearningEvent, { type: T }> => e.type === type);
}

describe("an Apply block phrase", () => {
  it("shows the phrase, asks to play it, and starts after a count-in", async () => {
    const r = await makeRig();
    await r.machine.start();
    const s = await until(r, listening);
    if (s.kind !== "listening") throw new Error("not listening");
    expect(s.item).toMatchObject({ block: "apply", generator: "pieceLine", nodeId: NODE });
    expect(s.prompt).toBe("Play this phrase");
    expect(s.item.display?.staves[0]?.clef).toBe("treble");
    expect(s.item.display?.staves[0]?.measures).toHaveLength(2);
    expect(r.notation.shows).toHaveLength(1);
    expect(r.h.player.plays).toHaveLength(1);
    expect(r.h.player.plays[0]?.spec.events.every((e) => e.role === "count-in")).toBe(true);
    expect(s.item.inputRange?.low).toBeLessThan(60);
  });

  it("grades a right phrase as correct and records it against the pieces node and the piece", async () => {
    const r = await makeRig();
    await r.machine.start();
    await play(r);
    expect(r.machine.state).toMatchObject({ kind: "feedback", feedback: { correct: true } });
    const log = await logOf(r);
    const presented = ofType(log, "item.presented")[0];
    expect(presented).toMatchObject({
      block: "apply",
      generator: "pieceLine",
      nodeId: NODE,
      itemId: `${NODE}|phrase=1|piece=${HCB}`,
      isNew: true,
      presentation: { piece: HCB, phrase: 1 },
    });
    const attempt = ofType(log, "attempt.completed")[0];
    expect(attempt).toMatchObject({ nodeId: NODE, outcome: { correct: true }, inputSource: "mic" });
    expect(ofType(log, "piece.completed")).toEqual([]);
    const phrase = r.h.service.state.pieces[HCB]?.phrases["1"];
    expect(phrase).toMatchObject({ attempts: 1, correct: 1, lastCorrect: true });
    expect(r.h.service.state.cards[`${NODE}|phrase=1|piece=${HCB}`]?.reps).toBe(1);
  });

  it("grades a wrong note as incorrect, names the pitch problem, and keeps the piece unfinished", async () => {
    const r = await makeRig();
    await r.machine.start();
    await play(r, 1);
    const s = r.machine.state;
    if (s.kind !== "feedback") throw new Error("not feedback");
    expect(s.feedback.correct).toBe(false);
    expect(s.feedback.lines.length).toBeGreaterThan(0);
    const attempt = ofType(await logOf(r), "attempt.completed")[0];
    expect(attempt?.outcome.correct).toBe(false);
    expect(attempt?.errors?.[0]).toMatchObject({ code: "sequence.wrong-note" });
    expect(r.h.service.state.pieces[HCB]?.phrases["1"]).toMatchObject({
      attempts: 1,
      correct: 0,
      lastCorrect: false,
    });
  });

  it("marks the notes on the staff in the feedback", async () => {
    const r = await makeRig();
    await r.machine.start();
    await play(r, 1);
    const marks = r.notation.marks.at(-1) ?? [];
    // Six notes (E D C, E D C); the second was played wrong.
    expect(marks.map((m) => m.kind)).toEqual([
      "target",
      "wrong",
      "target",
      "target",
      "target",
      "target",
    ]);
  });

  it("a session of phrases is not a run: no piece.completed", async () => {
    const r = await makeRig();
    await r.machine.start();
    await play(r);
    r.machine.next();
    await play(r);
    r.machine.finish();
    await until(r, summary);
    expect(ofType(await logOf(r), "piece.completed")).toEqual([]);
  });

  it("plays no phrase when notation cannot load: the items are dropped and the summary says so", async () => {
    const r = await makeRig({ notation: false });
    await r.machine.start();
    await r.machine.settled();
    const s = r.machine.state;
    expect(["summary", "nothing"]).toContain(s.kind);
    expect(ofType(await logOf(r), "item.presented")).toEqual([]);
  });
});

describe("a whole-piece run", () => {
  it("plays every phrase in order, then writes piece.completed before the session ends", async () => {
    const r = await makeRig({ run: HCB });
    await r.machine.start();
    await play(r);
    expect(r.machine.state).toMatchObject({ kind: "feedback", item: { position: 1, total: 2 } });
    r.machine.next();
    await play(r);
    expect(r.machine.state).toMatchObject({ kind: "feedback", item: { position: 2, total: 2 } });
    r.machine.next();
    await until(r, summary);

    const log = await logOf(r);
    const types = log.map((e) => e.type);
    expect(types.filter((t) => t === "piece.completed")).toHaveLength(1);
    expect(types.indexOf("piece.completed")).toBeLessThan(types.indexOf("session.ended"));
    expect(types.indexOf("piece.completed")).toBeGreaterThan(
      types.lastIndexOf("attempt.completed"),
    );
    expect(ofType(log, "piece.completed")[0]).toMatchObject({
      pieceId: HCB,
      phrases: 2,
      correctPhrases: 2,
    });
    expect(ofType(log, "item.presented").map((e) => e.itemId)).toEqual([
      `${NODE}|phrase=1|piece=${HCB}`,
      `${NODE}|phrase=2|piece=${HCB}`,
    ]);
    const piece = r.h.service.state.pieces[HCB];
    expect(piece?.runs).toBe(1);
    expect(piece?.completedAt).toBeDefined();
    const done = r.machine.state;
    if (done.kind !== "summary") throw new Error("not a summary");
    expect(done.summary.run).toEqual({ pieceId: HCB, phrases: 2, correctPhrases: 2 });
  });

  it("with a wrong phrase the run is logged but the piece is not played through", async () => {
    const r = await makeRig({ run: HCB });
    await r.machine.start();
    await play(r);
    r.machine.next();
    await play(r, 0);
    r.machine.next();
    await until(r, summary);
    const completed = ofType(await logOf(r), "piece.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ phrases: 2, correctPhrases: 1 });
    const done = r.machine.state;
    if (done.kind !== "summary") throw new Error("not a summary");
    expect(done.summary.run).toEqual({ pieceId: HCB, phrases: 2, correctPhrases: 1 });
    const piece = r.h.service.state.pieces[HCB];
    expect(piece?.runs).toBe(1);
    expect(piece?.completedAt).toBeUndefined();
  });

  it("a skipped phrase counts as not correct", async () => {
    const r = await makeRig({ run: HCB });
    await r.machine.start();
    await play(r);
    r.machine.next();
    await until(r, listening);
    r.machine.skip();
    await until(r, feedback);
    r.machine.next();
    await until(r, summary);
    expect(ofType(await logOf(r), "piece.completed")[0]).toMatchObject({ correctPhrases: 1 });
  });

  it("finishing early writes no piece.completed", async () => {
    const r = await makeRig({ run: HCB });
    await r.machine.start();
    await play(r);
    r.machine.finish();
    await until(r, summary);
    const log = await logOf(r);
    expect(ofType(log, "piece.completed")).toEqual([]);
    expect(r.machine.state).toMatchObject({ kind: "summary" });
    expect((r.machine.state as { summary: { run?: unknown } }).summary.run).toBeUndefined();
    expect(ofType(log, "attempt.completed")).toHaveLength(1);
    expect(ofType(log, "session.ended")[0]?.reason).toBe("completed");
    expect(r.h.service.state.pieces[HCB]?.runs ?? 0).toBe(0);
  });

  it("running the same piece again counts another run and keeps the first completion time", async () => {
    const first = await makeRig({ run: HCB });
    await first.machine.start();
    await play(first);
    first.machine.next();
    await play(first);
    first.machine.next();
    await until(first, summary);
    const history = [...trebleHistory(), ...(await logOf(first))];
    const completedAt = first.h.service.state.pieces[HCB]?.completedAt;

    const h = await makeHarness({ budgetSec: 600, graph, history, idSalt: 91 });
    h.clock.ctxMs += 3 * 3_600_000;
    const notation = new FakeNotation(h.clock);
    const machine = new SessionMachine({
      ...h.deps,
      notation,
      compose: (input) =>
        composePieceRun({
          state: input.state,
          graph: input.graph,
          pieces,
          pieceId: HCB,
          now: input.now,
          tzOffsetMin: input.tzOffsetMin,
          generators,
        }),
      generate: (item, ctx) => {
        const node = h.graph.nodes.find((n) => n.id === item.nodeId);
        const gen = generators[item.generator];
        if (!node || !gen) throw new Error("cannot generate");
        return gen.generate(node, item.params, ctx);
      },
    });
    const r: Rig = { h, machine, notation };
    await machine.start();
    await play(r);
    machine.next();
    await play(r);
    machine.next();
    await until(r, summary);
    expect(h.service.state.pieces[HCB]).toMatchObject({ runs: 2, completedAt });
  });
});

describe("play it by ear (TP.6)", () => {
  const EAR_NODE = "apply.piece-ear";

  /** A learner who has played every phrase of Hot Cross Buns right, a few hours ago. */
  async function readHistory(): Promise<LearningEvent[]> {
    const first = await makeRig({ run: HCB });
    await first.machine.start();
    await play(first);
    first.machine.next();
    await play(first);
    first.machine.next();
    await until(first, summary);
    return [...trebleHistory(), ...(await logOf(first))];
  }

  async function makeEarRig(): Promise<Rig> {
    const h = await makeHarness({
      budgetSec: 600,
      graph,
      history: await readHistory(),
      idSalt: 77,
    });
    h.clock.ctxMs += 3 * 3_600_000;
    const notation = new FakeNotation(h.clock);
    const machine = new SessionMachine({
      ...h.deps,
      notation,
      compose: (input) => {
        const plan = composeSession({ ...input, pieces, generators });
        return {
          ...plan,
          orient: null,
          introductions: [],
          blocks: {
            ear: [],
            read: [],
            apply: (plan.blocks.apply ?? []).filter((i) => i.generator === "pieceEar"),
          },
        };
      },
      generate: (item, ctx) => {
        const node = h.graph.nodes.find((n) => n.id === item.nodeId);
        const gen = generators[item.generator];
        if (!node || !gen) throw new Error("cannot generate");
        return gen.generate(node, item.params, ctx);
      },
    });
    return { h, machine, notation };
  }

  const cue = (s: SessionState): boolean => s.kind === "listening" && s.cue;
  const playing = (s: SessionState): boolean => s.kind === "listening" && !s.cue && !s.practice;

  /** Leave the cue step (sing or hum it, ungraded), as the Ready button does. */
  async function ready(r: Rig): Promise<void> {
    await until(r, cue);
    r.machine.ready();
    await until(r, playing);
  }

  /** Play the phrase right, once the played step is open, and wait for the feedback. */
  async function playPhrase(r: Rig): Promise<void> {
    await ready(r);
    const expected = r.machine.debug().expected;
    playCorrect(r.h.input, expected ?? { responseWindowMs: 1 }, r.h.clock.ctxMs + 700);
    await until(r, feedback);
  }

  it("offers the first phrase of a piece the learner can read, with no score on screen", async () => {
    const r = await makeEarRig();
    await r.machine.start();
    const s = await until(r, cue);
    if (s.kind !== "listening") throw new Error("not listening");
    expect(s.item).toMatchObject({ block: "apply", generator: "pieceEar", nodeId: EAR_NODE });
    expect(s.item.display).toBeUndefined();
    expect(s.item.revealed).toBeUndefined();
    expect(s.prompt).toBe("Sing or hum it, out loud or in your head");
    expect(s.phaseCount).toBe(1);
    expect(r.notation.shows).toHaveLength(0);
    // The phrase was played: a count-in bar, then the notes.
    const played = r.h.player.plays.at(-1)?.spec.events ?? [];
    expect(played.filter((e) => e.role === "count-in")).toHaveLength(4);
    expect(played.filter((e) => e.role === "target")).toHaveLength(6);
  });

  it("goes hear, cue, play, reveal: the score appears only after the answer, with the notes marked", async () => {
    const r = await makeEarRig();
    await r.machine.start();
    await ready(r);
    const s = r.machine.state;
    if (s.kind !== "listening") throw new Error("not listening");
    expect(s.prompt).toBe("Play it");
    expect(r.notation.shows).toHaveLength(0);
    const expected = r.machine.debug().expected;
    playCorrect(r.h.input, expected ?? { responseWindowMs: 1 }, r.h.clock.ctxMs + 700);
    await until(r, feedback);
    await r.machine.settled();
    const done = r.machine.state;
    if (done.kind !== "feedback") throw new Error("not feedback");
    expect(done.feedback.correct).toBe(true);
    expect(done.feedback.autoAdvance).toBe(false);
    expect(done.item.revealed).toBe(true);
    expect(r.notation.shows).toHaveLength(1);
    expect(r.notation.shows[0]?.staves[0]?.measures).toHaveLength(2);
    expect(r.notation.marks.at(-1)?.map((m) => m.kind)).toEqual(Array<string>(6).fill("right"));
  });

  it("the cue grades nothing and has no timer", async () => {
    const r = await makeEarRig();
    await r.machine.start();
    await until(r, cue);
    await r.h.advance(300_000);
    expect(cue(r.machine.state)).toBe(true);
    const byEar = ofType(await logOf(r), "attempt.completed").filter((a) => a.nodeId === EAR_NODE);
    expect(byEar).toHaveLength(0);
  });

  it("records one attempt on the by-ear node with only the played sub-score, and leaves reading progress alone", async () => {
    const r = await makeEarRig();
    await r.machine.start();
    await playPhrase(r);
    const log = await logOf(r);
    const attempt = ofType(log, "attempt.completed").at(-1);
    expect(attempt).toMatchObject({
      nodeId: EAR_NODE,
      itemId: `${EAR_NODE}|phrase=1|piece=${HCB}`,
      outcome: { correct: true },
    });
    expect(attempt?.subScores).toEqual({ play: 1 });
    const presented = ofType(log, "item.presented").at(-1);
    expect(presented).toMatchObject({ generator: "pieceEar", block: "apply", isNew: true });
    // The reading record is exactly what the earlier run left.
    expect(r.h.service.state.pieces[HCB]?.phrases["1"]?.attempts).toBe(1);
    expect(r.h.service.state.cards[`${EAR_NODE}|phrase=1|piece=${HCB}`]?.reps).toBe(1);
  });

  it("a wrong played note is not correct, names the playing, and never mentions singing", async () => {
    const r = await makeEarRig();
    await r.machine.start();
    await ready(r);
    const expectedPlay = r.machine.debug().expected?.play;
    if (expectedPlay?.kind !== "line") throw new Error("not a line");
    const start = r.h.clock.ctxMs + 700;
    const beatMs = 60000 / expectedPlay.tempoBpm;
    expectedPlay.midi.forEach((m, i) => {
      r.h.input.emitNote({
        pitch: i === 2 ? m + 1 : m,
        onsetMs: start + (expectedPlay.onsetsBeats[i] ?? 0) * beatMs,
        confidence: 1,
        source: "mic",
      });
    });
    await until(r, feedback);
    await r.machine.settled();
    const done = r.machine.state;
    if (done.kind !== "feedback") throw new Error("not feedback");
    expect(done.feedback.correct).toBe(false);
    expect(done.item.revealed).toBe(true);
    const attempt = ofType(await logOf(r), "attempt.completed").at(-1);
    expect(attempt?.outcome.correct).toBe(false);
    expect(attempt?.errors?.length).toBeGreaterThan(0);
    expect(JSON.stringify(attempt?.errors)).not.toMatch(/sing|sang|sung/i);
    expect(attempt?.subScores?.sing).toBeUndefined();
    expect(done.feedback.lines.join(" ")).not.toMatch(/sang|sung|sing/i);
    // The revealed score marks the note that was played wrong.
    expect(r.notation.marks.at(-1)?.filter((m) => m.kind === "wrong")).toHaveLength(1);
  });

  it("moving on clears the revealed score", async () => {
    const r = await makeEarRig();
    await r.machine.start();
    await playPhrase(r);
    await r.machine.settled();
    const hides = r.notation.count("hide");
    r.machine.finish();
    await until(r, summary);
    expect(r.notation.count("hide")).toBeGreaterThan(hides);
  });

  it("without notation the by-ear phrase is dropped with the reading ones", async () => {
    const h = await makeHarness({
      budgetSec: 600,
      graph,
      history: await readHistory(),
      idSalt: 78,
    });
    h.clock.ctxMs += 3 * 3_600_000;
    const machine = new SessionMachine({
      ...h.deps,
      compose: (input) => {
        const plan = composeSession({ ...input, pieces, generators });
        return {
          ...plan,
          orient: null,
          introductions: [],
          blocks: {
            ear: [],
            read: [],
            apply: (plan.blocks.apply ?? []).filter((i) => i.generator === "pieceEar"),
          },
        };
      },
      generate: (item, ctx) => {
        const node = h.graph.nodes.find((n) => n.id === item.nodeId);
        const gen = generators[item.generator];
        if (!node || !gen) throw new Error("cannot generate");
        return gen.generate(node, item.params, ctx);
      },
    });
    await machine.start();
    await machine.settled();
    expect(["summary", "nothing"]).toContain(machine.state.kind);
    expect(
      ofType(await h.log(), "item.presented").filter((e) => e.generator === "pieceEar"),
    ).toEqual([]);
  });
});
