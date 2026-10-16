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
import { SessionMachine, type SessionState } from "./machine";
import {
  FakeNotation,
  logOf,
  makeHarness,
  playCorrect,
  singCorrect,
  sungFrames,
  type Harness,
} from "./test-harness";

/* By-ear melodies (BYEAR, T7.2): hear, sing, play, reveal. Real graph, real generator and real
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

const phase = (p: "sing" | "play") => (s: SessionState) => s.kind === "listening" && s.phase === p;
const feedback = (s: SessionState): boolean => s.kind === "feedback";

/** Sing the melody (right, or with the note at `wrongAt` three semitones up), once the sung phase is open. */
async function sing(r: Rig, wrongAt?: number): Promise<void> {
  await until(r, phase("sing"));
  const expected = r.machine.debug().expected;
  const target = expected?.sing;
  if (target?.kind !== "sungSequence") throw new Error("not a sung sequence");
  const start = r.h.clock.ctxMs + 200;
  if (wrongAt === undefined) {
    singCorrect(r.h.input, expected ?? { responseWindowMs: 1 }, start);
  } else {
    target.midi.forEach((m, i) => {
      for (const f of sungFrames(m + (i === wrongAt ? 3 : 0), start + i * 400)) {
        r.h.input.emitFrame(f);
      }
    });
  }
  await until(r, phase("play"));
}

async function playMelody(r: Rig): Promise<void> {
  await until(r, phase("play"));
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

describe("a by-ear melody (T7.2)", () => {
  it("hear: plays the key-setting cadence then the melody, with no score and the sung part first", async () => {
    const r = await makeRig();
    await r.machine.start();
    const s = await until(r, phase("sing"));
    if (s.kind !== "listening") throw new Error("not listening");
    expect(s.item).toMatchObject({ block: "apply", generator: "byEarPhrase", nodeId: NODE });
    expect(s.item.display).toBeUndefined();
    expect(s.item.revealed).toBeUndefined();
    expect(s.prompt).toBe("Sing it");
    expect(s.phaseCount).toBe(2);
    expect(r.notation.shows).toHaveLength(0);

    const events = r.h.player.plays.at(-1)?.spec.events ?? [];
    const cadence = events.filter((e) => e.role === "cadence");
    const targets = events.filter((e) => e.role === "target");
    expect(cadence.length).toBeGreaterThan(0);
    expect(targets.length).toBeGreaterThan(8);
    const cadenceEnd = Math.max(...cadence.map((e) => e.atSec + e.durationSec));
    expect(Math.min(...targets.map((e) => e.atSec))).toBeGreaterThanOrEqual(cadenceEnd);
  });

  it("sing: a right sung part opens the played part, still with no score", async () => {
    const r = await makeRig();
    await r.machine.start();
    await sing(r);
    const s = r.machine.state;
    if (s.kind !== "listening") throw new Error("not listening");
    expect(s.prompt).toBe("Now play it");
    expect(r.notation.shows).toHaveLength(0);
  });

  it("play and reveal: the score appears only after the answer, with every note marked right", async () => {
    const r = await makeRig();
    await r.machine.start();
    await sing(r);
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

  it("records one attempt on the by-ear node with both sub-scores", async () => {
    const r = await makeRig();
    await r.machine.start();
    await sing(r);
    await playMelody(r);
    const log = await logOf(r);
    const attempt = attemptsOf(log).at(-1);
    expect(attempt).toMatchObject({ nodeId: NODE, itemId: ITEM_ID, outcome: { correct: true } });
    expect(attempt?.subScores?.sing).toBeDefined();
    expect(attempt?.subScores?.play).toBeDefined();
    const presented = log.filter((e) => e.type === "item.presented").at(-1);
    expect(presented).toMatchObject({ generator: "byEarPhrase", block: "apply", isNew: true });
    expect(r.h.service.state.cards[ITEM_ID]?.reps).toBe(1);
  });

  it("a wrong sung note reads Not quite and names the singing, even with the playing right", async () => {
    const r = await makeRig();
    await r.machine.start();
    await sing(r, 2);
    await playMelody(r);
    await r.machine.settled();
    const done = r.machine.state;
    if (done.kind !== "feedback") throw new Error("not feedback");
    expect(done.feedback.correct).toBe(false);
    expect(done.item.revealed).toBe(true);
    const attempt = attemptsOf(await logOf(r)).at(-1);
    expect(attempt?.outcome.correct).toBe(false);
    expect(attempt?.errors?.length).toBeGreaterThan(0);
    expect(attempt?.errors?.every((e) => e.detail?.part === "sing")).toBe(true);
    expect(attempt?.subScores?.play).toBe(1);
    expect(attempt?.subScores?.sing ?? 1).toBeLessThan(1);
    expect(done.feedback.lines.join(" ")).toMatch(/you sang/i);
    // The reveal marks the sung note that was wrong.
    expect(r.notation.marks.at(-1)?.filter((m) => m.kind === "wrong")).toHaveLength(1);
  });

  it("a wrong played note is not correct and names the playing, with the singing right", async () => {
    const r = await makeRig();
    await r.machine.start();
    await sing(r);
    await until(r, phase("play"));
    const play = r.machine.debug().expected?.play;
    if (play?.kind !== "line") throw new Error("not a line");
    const start = r.h.clock.ctxMs + 700;
    const beatMs = 60000 / play.tempoBpm;
    play.midi.forEach((m, i) => {
      const onset = start + (play.onsetsBeats[i] ?? 0) * beatMs;
      r.h.input.emitNote({
        pitch: i === 3 ? m + 1 : m,
        onsetMs: onset,
        confidence: 1,
        source: "mic",
      });
    });
    await until(r, feedback);
    const attempt = attemptsOf(await logOf(r)).at(-1);
    expect(attempt?.outcome.correct).toBe(false);
    expect(attempt?.errors?.every((e) => e.detail?.part === "play")).toBe(true);
    expect(attempt?.subScores?.sing).toBe(1);
    expect(r.machine.state.kind === "feedback" && r.machine.state.feedback.lines.join(" ")).toMatch(
      /you played/i,
    );
  });

  it("moving on clears the revealed score", async () => {
    const r = await makeRig();
    await r.machine.start();
    await sing(r);
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
