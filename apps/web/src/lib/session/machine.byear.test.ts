import { loadGraph } from "@clavis/content";
import {
  GENERATORS,
  composeSession,
  type GenerateContext,
  type ItemInstance,
  type LearningEvent,
  type PlannedItem,
} from "@clavis/core";
import { describe, expect, it } from "vitest";
import { CUE_PROMPT, SessionMachine, type SessionState } from "./machine";
import { FakeNotation, logOf, makeHarness, playCorrect, type Harness } from "./test-harness";

/* By-ear melodies (BYEAR, T7.2, R29): hear, cue (sing or hum it, ungraded), play, reveal. Real graph, real generator and real
   scorer; the plan is the one melody and the notation port is a fake. */

const NODE = "byear.melody.simple";
const ITEM_ID = `${NODE}|bars=4|slot=1`;

interface Rig {
  h: Harness;
  machine: SessionMachine;
  notation: FakeNotation;
}

async function makeRig(opts: { notation?: boolean } = {}): Promise<Rig> {
  const h = await makeHarness({ budgetSec: 600, graph: loadGraph() });
  const notation = new FakeNotation(h.clock);
  const planned: PlannedItem = {
    itemId: ITEM_ID,
    nodeId: NODE,
    generator: "byEarPhrase",
    params: { bars: 4, slot: 1 },
    isNew: true,
    estimatedSec: 90,
  };
  const machine = new SessionMachine({
    ...h.deps,
    ...(opts.notation === false ? {} : { notation }),
    compose: (input) => {
      const plan = composeSession(input);
      return {
        ...plan,
        orient: null,
        introductions: [],
        blocks: { ear: [], read: [], apply: [planned] },
      };
    },
    generate: (item: PlannedItem, ctx: GenerateContext): ItemInstance => {
      const node = h.graph.nodes.find((n) => n.id === item.nodeId);
      const gen = GENERATORS[item.generator];
      if (!node || !gen) throw new Error(`cannot generate ${item.generator}`);
      return gen.generate(node, item.params, ctx);
    },
  });
  return { h, machine, notation };
}

async function until(
  r: Rig,
  pred: (s: SessionState) => boolean,
  maxMs = 120_000,
): Promise<SessionState> {
  for (let t = 0; t < maxMs && !pred(r.machine.state); t += 50) await r.h.advance(50);
  if (!pred(r.machine.state)) {
    throw new Error(`condition not reached, stuck in ${JSON.stringify(r.machine.state)}`);
  }
  return r.machine.state;
}

const play = (s: SessionState): boolean => s.kind === "listening" && !s.cue && !s.practice;
const cue = (s: SessionState): boolean => s.kind === "listening" && s.cue;
const feedback = (s: SessionState): boolean => s.kind === "feedback";

/** Leave the cue step, as the Ready button does. */
async function ready(r: Rig): Promise<void> {
  await until(r, cue);
  r.machine.ready();
  await until(r, play);
}

async function playMelody(r: Rig): Promise<void> {
  await ready(r);
  const expected = r.machine.debug().expected;
  playCorrect(r.h.input, expected ?? { responseWindowMs: 1 }, r.h.clock.ctxMs + 700);
  await until(r, feedback);
}

function attemptsOf(log: LearningEvent[]) {
  return log.filter(
    (e): e is Extract<LearningEvent, { type: "attempt.completed" }> =>
      e.type === "attempt.completed",
  );
}

describe("a by-ear melody (T7.2, R29)", () => {
  it("hear: plays the key-setting cadence then the melody, with no score, then holds at the cue", async () => {
    const r = await makeRig();
    await r.machine.start();
    const s = await until(r, cue);
    if (s.kind !== "listening") throw new Error("not listening");
    expect(s.item).toMatchObject({ block: "apply", generator: "byEarPhrase", nodeId: NODE });
    expect(s.item.display).toBeUndefined();
    expect(s.item.revealed).toBeUndefined();
    expect(s.prompt).toBe(CUE_PROMPT);
    expect(s.prompt).toBe("Sing or hum it, out loud or in your head");
    expect(s.phaseCount).toBe(1);
    expect(s.practice).toBe(false);
    expect(s.canHear).toBe(true);
    expect(r.notation.shows).toHaveLength(0);
    expect(r.machine.debug().phase).toBe("listening-cue");

    const events = r.h.player.plays.at(-1)?.spec.events ?? [];
    const cadence = events.filter((e) => e.role === "cadence");
    const targets = events.filter((e) => e.role === "target");
    expect(cadence.length).toBeGreaterThan(0);
    expect(targets.length).toBeGreaterThan(8);
    const cadenceEnd = Math.max(...cadence.map((e) => e.atSec + e.durationSec));
    expect(Math.min(...targets.map((e) => e.atSec))).toBeGreaterThanOrEqual(cadenceEnd);
  });

  it("cue: grades nothing, writes no attempt and has no timer", async () => {
    const r = await makeRig();
    await r.machine.start();
    await until(r, cue);
    // Notes played during the cue are not answers, and ten minutes pass without a timeout.
    playCorrect(
      r.h.input,
      r.machine.debug().expected ?? { responseWindowMs: 1 },
      r.h.clock.ctxMs + 200,
    );
    await r.h.advance(600_000);
    expect(cue(r.machine.state)).toBe(true);
    expect(attemptsOf(await r.h.log())).toHaveLength(0);
  });

  it("cue: Hear it again replays the tune and stays at the cue", async () => {
    const r = await makeRig();
    await r.machine.start();
    await until(r, cue);
    const plays = r.h.player.plays.length;
    r.machine.hear("full");
    expect(r.h.player.plays.length).toBe(plays + 1);
    await until(r, cue);
    expect(r.machine.state).toMatchObject({ kind: "listening", cue: true });
  });

  it("ready: opens the played part with the play prompt, still with no score", async () => {
    const r = await makeRig();
    await r.machine.start();
    await ready(r);
    const s = r.machine.state;
    if (s.kind !== "listening") throw new Error("not listening");
    expect(s).toMatchObject({ cue: false, prompt: "Play it" });
    expect(r.notation.shows).toHaveLength(0);
  });

  it("play and reveal: the score appears only after the answer, with every note marked right", async () => {
    const r = await makeRig();
    await r.machine.start();
    await playMelody(r);
    await r.machine.settled();
    const done = r.machine.state;
    if (done.kind !== "feedback") throw new Error("not feedback");
    expect(done.feedback.correct).toBe(true);
    expect(done.feedback.autoAdvance).toBe(false);
    expect(done.item.revealed).toBe(true);
    expect(r.notation.shows).toHaveLength(1);
    const measures = r.notation.shows[0]?.staves[0]?.measures ?? [];
    expect(measures).toHaveLength(4);
    const noteCount = measures.flat().length;
    expect(r.notation.marks.at(-1)?.map((m) => m.kind)).toEqual(
      Array<string>(noteCount).fill("right"),
    );
  });

  it("records one attempt on the by-ear node with only the played sub-score", async () => {
    const r = await makeRig();
    await r.machine.start();
    await playMelody(r);
    const log = await logOf(r);
    const attempt = attemptsOf(log).at(-1);
    expect(attempt).toMatchObject({ nodeId: NODE, itemId: ITEM_ID, outcome: { correct: true } });
    expect(attempt?.subScores).toEqual({ play: 1 });
    const presented = log.filter((e) => e.type === "item.presented").at(-1);
    expect(presented).toMatchObject({ generator: "byEarPhrase", block: "apply", isNew: true });
    expect(r.h.service.state.cards[ITEM_ID]?.reps).toBe(1);
  });

  it("latency counts from Ready, not from the end of the tune", async () => {
    const r = await makeRig();
    await r.machine.start();
    await until(r, cue);
    await r.h.advance(120_000);
    await ready(r);
    playCorrect(
      r.h.input,
      r.machine.debug().expected ?? { responseWindowMs: 1 },
      r.h.clock.ctxMs + 700,
    );
    await until(r, feedback);
    const attempt = attemptsOf(await logOf(r)).at(-1);
    expect(attempt?.outcome.correct).toBe(true);
    expect(attempt?.outcome.latencyMs).toBeLessThan(10_000);
  });

  it("a wrong played note is not correct, names the playing, and never mentions singing", async () => {
    const r = await makeRig();
    await r.machine.start();
    await ready(r);
    const expectedPlay = r.machine.debug().expected?.play;
    if (expectedPlay?.kind !== "line") throw new Error("not a line");
    const start = r.h.clock.ctxMs + 700;
    const beatMs = 60000 / expectedPlay.tempoBpm;
    expectedPlay.midi.forEach((m, i) => {
      const onset = start + (expectedPlay.onsetsBeats[i] ?? 0) * beatMs;
      r.h.input.emitNote({
        pitch: i === 3 ? m + 1 : m,
        onsetMs: onset,
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
    const attempt = attemptsOf(await logOf(r)).at(-1);
    expect(attempt?.outcome.correct).toBe(false);
    expect(attempt?.errors?.length).toBeGreaterThan(0);
    expect(JSON.stringify(attempt?.errors)).not.toMatch(/sing|sang|sung/i);
    expect(attempt?.subScores?.sing).toBeUndefined();
    expect(done.feedback.lines.join(" ")).toMatch(/you played/i);
    expect(done.feedback.lines.join(" ")).not.toMatch(/sang|sung|sing/i);
    // The reveal marks the note that was wrong.
    expect(r.notation.marks.at(-1)?.filter((m) => m.kind === "wrong")).toHaveLength(1);
  });

  it("moving on clears the revealed score", async () => {
    const r = await makeRig();
    await r.machine.start();
    await playMelody(r);
    await r.machine.settled();
    const hides = r.notation.count("hide");
    r.machine.finish();
    await until(r, (s) => s.kind === "summary");
    expect(r.notation.count("hide")).toBeGreaterThan(hides);
  });

  it("without notation the melody is dropped: it could not be revealed", async () => {
    const r = await makeRig({ notation: false });
    await r.machine.start();
    await r.machine.settled();
    expect(["summary", "nothing"]).toContain(r.machine.state.kind);
    expect(
      (await r.h.log()).filter((e) => e.type === "item.presented" && e.generator === "byEarPhrase"),
    ).toEqual([]);
  });
});
