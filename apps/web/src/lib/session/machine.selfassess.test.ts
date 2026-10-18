import {
  GENERATORS,
  type GenerateContext,
  type ItemInstance,
  type LearnerState,
  type LearningEvent,
  type NodeState,
  type PlannedItem,
} from "@clavis/core";
import { describe, expect, it } from "vitest";
import { SELF_ASSESS_EVERY, SessionMachine, type SessionState } from "./machine";
import { FakeNotation, logOf, makeHarness, playCorrect, type Harness } from "./test-harness";

/*
 * Self-assessment (T6.6, R28, spec 8.4): before feedback, on every third answer to a fluent or
 * mastered skill in a session, the learner says whether they think they got it right. Never in
 * placement, extra practice, piece runs or revealed scores, and never without an answer.
 */

interface Rig {
  h: Harness;
  machine: SessionMachine;
  notation: FakeNotation;
}

interface RigOptions {
  /** Every node reads as this stage once the first item is on screen. */
  stage: NodeState;
  placement?: boolean;
  practice?: boolean;
  /** Mark the composed plan as a whole-piece run. */
  run?: boolean;
  /** A single by-ear melody, whose score is revealed after the answer. */
  byEar?: boolean;
}

async function makeRig(o: RigOptions): Promise<Rig> {
  const h = await makeHarness({ budgetSec: 900, ...(o.placement ? { placement: true } : {}) });
  const notation = new FakeNotation(h.clock);
  // The composer sees the real state; the stage applies once the first item is presented.
  let active = false;
  const getState = (): LearnerState => {
    const s = h.deps.getState();
    if (!active) return s;
    const nodes: LearnerState["nodes"] = { ...s.nodes };
    for (const n of h.graph.nodes) nodes[n.id] = { ...s.nodes[n.id], state: o.stage };
    return { ...s, nodes };
  };
  const melody: PlannedItem = {
    itemId: "byear.melody.simple|bars=4|slot=1",
    nodeId: "byear.melody.simple",
    generator: "byEarPhrase",
    params: { bars: 4, slot: 1 },
    isNew: false,
    estimatedSec: 90,
  };
  const machine = new SessionMachine({
    ...h.deps,
    getState,
    ...(o.practice ? { practice: true } : {}),
    ...(o.byEar ? { notation } : {}),
    compose: (input) => {
      // Extra practice needs earlier history to compose; the machine only reads the flag.
      const plan = h.deps.compose({ ...input, practice: false });
      if (o.byEar) {
        return {
          ...plan,
          orient: null,
          introductions: [],
          blocks: { ear: [], read: [], apply: [melody] },
        };
      }
      // A new learner's plan is short, so its items are asked three times over.
      const ear = [...plan.blocks.ear, ...plan.blocks.ear, ...plan.blocks.ear];
      const longer = { ...plan, blocks: { ...plan.blocks, ear } };
      return o.run ? { ...longer, run: { pieceId: "piece.test" } } : longer;
    },
    generate: (item: PlannedItem, ctx: GenerateContext): ItemInstance => {
      const node = h.graph.nodes.find((n) => n.id === item.nodeId);
      const gen = GENERATORS[item.generator];
      if (!node || !gen) throw new Error(`cannot generate ${item.generator}`);
      return gen.generate(node, item.params, ctx);
    },
  });
  machine.subscribe((s) => {
    h.states.push(s);
    if (s.kind === "presenting") active = true;
  });
  return { h, machine, notation };
}

async function until(
  r: Rig,
  pred: (s: SessionState) => boolean,
  maxMs = 120_000,
): Promise<SessionState> {
  for (let t = 0; t < maxMs && !pred(r.machine.state); t += 50) {
    await r.h.advance(50);
    await r.machine.settled();
  }
  if (!pred(r.machine.state)) {
    throw new Error(`condition not reached, stuck in ${JSON.stringify(r.machine.state)}`);
  }
  return r.machine.state;
}

const AFTER_ANSWER: ReadonlySet<SessionState["kind"]> = new Set([
  "selfAssess",
  "feedback",
  "summary",
]);

/** Past the warm-up and any intro card, to the next item's question. */
async function toQuestion(r: Rig): Promise<SessionState> {
  for (;;) {
    const s = await until(
      r,
      (x) =>
        x.kind === "listening" || x.kind === "orient" || x.kind === "intro" || x.kind === "summary",
    );
    if (s.kind !== "orient" && s.kind !== "intro") return s;
    r.machine.next();
  }
}

/** Answer every phase of the current item (right), and wait for what follows the answer. */
async function answerItem(r: Rig): Promise<SessionState> {
  for (;;) {
    const s = await until(r, (x) => x.kind === "listening" || AFTER_ANSWER.has(x.kind));
    if (s.kind !== "listening") return s;
    if (s.cue) {
      // Play by ear (R29): the ungraded "sing or hum it" step waits for Ready.
      r.machine.ready();
      await until(r, (x) => !(x.kind === "listening" && x.cue));
      continue;
    }
    const expected = r.machine.debug().expected;
    if (!expected) throw new Error("no expected response");
    const start = r.h.clock.ctxMs + 200;
    const play = expected.play;
    if (play?.kind === "choice") r.machine.answerChoice(play.options[0]?.id ?? "");
    else playCorrect(r.h.input, expected, start + 500);
    await until(r, (x) => x.kind !== "listening");
  }
}

function attemptsOf(log: LearningEvent[]) {
  return log.filter(
    (e): e is Extract<LearningEvent, { type: "attempt.completed" }> =>
      e.type === "attempt.completed",
  );
}

/** Answer `count` items, self-assessing when asked (right, wrong, right...). Returns what was asked. */
async function answerItems(r: Rig, count: number): Promise<boolean[]> {
  const asked: boolean[] = [];
  let say: "right" | "wrong" = "right";
  for (let i = 0; i < count; i++) {
    const q = await toQuestion(r);
    if (q.kind === "summary") break;
    const after = await answerItem(r);
    asked.push(after.kind === "selfAssess");
    if (after.kind === "selfAssess") {
      r.machine.selfAssess(say);
      say = say === "right" ? "wrong" : "right";
    }
    expect(r.machine.state.kind).toBe("feedback");
    r.machine.next();
  }
  return asked;
}

const everyThird = (n: number): boolean[] =>
  Array.from({ length: n }, (_, i) => i % SELF_ASSESS_EVERY === 0);

describe("self-assessment (T6.6)", () => {
  it.each(["fluent", "mastered"] as const)(
    "%s: asked on every third attempt, starting with the first, and logged on attempt v2",
    async (stage) => {
      const r = await makeRig({ stage });
      await r.machine.start();
      const asked = await answerItems(r, 7);
      expect(asked).toEqual(everyThird(7));

      const attempts = attemptsOf(await logOf(r));
      expect(attempts).toHaveLength(7);
      expect(attempts.map((a) => a.v)).toEqual(Array<number>(7).fill(2));
      expect(attempts.map((a) => a.selfAssessment)).toEqual([
        "right",
        undefined,
        undefined,
        "wrong",
        undefined,
        undefined,
        "right",
      ]);
      // Saying "wrong" about a right answer changes nothing about how it was graded.
      expect(attempts[3]?.outcome.correct).toBe(true);
    },
  );

  it("is not asked for skills still being learned", async () => {
    const r = await makeRig({ stage: "learning" });
    await r.machine.start();
    expect(await answerItems(r, 4)).toEqual([false, false, false, false]);
    expect(r.h.states.some((s) => s.kind === "selfAssess")).toBe(false);
    const attempts = attemptsOf(await logOf(r));
    expect(attempts.every((a) => a.selfAssessment === undefined)).toBe(true);
  });

  it("hides the result until the learner answers, then shows feedback as usual", async () => {
    const r = await makeRig({ stage: "fluent" });
    await r.machine.start();
    await toQuestion(r);
    const s = await answerItem(r);
    expect(s).toMatchObject({ kind: "selfAssess", canRetry: true });
    expect("feedback" in s).toBe(false);
    // Waiting, or pressing Next, does not move on: only an answer (or Skip) does.
    await r.h.advance(10_000);
    r.machine.next();
    expect(r.machine.state.kind).toBe("selfAssess");
    r.machine.selfAssess("wrong");
    expect(r.machine.state).toMatchObject({ kind: "feedback", feedback: { correct: true } });
  });

  it("is not asked when no answer was given, and that attempt does not count", async () => {
    const r = await makeRig({ stage: "fluent" });
    await r.machine.start();
    await toQuestion(r);
    // Let the response window run out.
    const timedOut = await until(r, (x) => AFTER_ANSWER.has(x.kind));
    expect(timedOut).toMatchObject({ kind: "feedback", feedback: { correct: false } });
    r.machine.next();
    // A skipped item is not asked either.
    await toQuestion(r);
    r.machine.skip();
    await r.machine.settled();
    expect(r.machine.state.kind).toBe("feedback");
    r.machine.next();
    // The first answered attempt is the first that counts.
    expect(await answerItems(r, 1)).toEqual([true]);
  });

  it("is never asked in placement", async () => {
    const r = await makeRig({ stage: "mastered", placement: true });
    await r.machine.start();
    for (let i = 0; i < 4; i++) {
      const q = await until(r, (x) => x.kind === "listening" || x.kind === "summary");
      if (q.kind === "summary") break;
      await answerItem(r);
    }
    expect(r.h.states.some((s) => s.kind === "selfAssess")).toBe(false);
  });

  it("is never asked in extra practice", async () => {
    const r = await makeRig({ stage: "fluent", practice: true });
    await r.machine.start();
    expect(await answerItems(r, 4)).toEqual([false, false, false, false]);
  });

  it("is never asked in a piece run", async () => {
    const r = await makeRig({ stage: "fluent", run: true });
    await r.machine.start();
    expect(await answerItems(r, 4)).toEqual([false, false, false, false]);
  });

  it("is never asked on a revealed score (play by ear)", async () => {
    const r = await makeRig({ stage: "fluent", byEar: true });
    await r.machine.start();
    const s = await answerItem(r);
    expect(s).toMatchObject({ kind: "feedback", item: { revealed: true } });
    expect(r.h.states.some((x) => x.kind === "selfAssess")).toBe(false);
  });

  it("Try again drops the attempt and asks again on the next go", async () => {
    const r = await makeRig({ stage: "fluent" });
    await r.machine.start();
    await toQuestion(r);
    expect((await answerItem(r)).kind).toBe("selfAssess");
    r.machine.retry();
    expect(r.machine.state.kind).toBe("presenting");
    expect((await answerItem(r)).kind).toBe("selfAssess");
    r.machine.selfAssess("right");
    const attempts = attemptsOf(await logOf(r));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.selfAssessment).toBe("right");
  });

  it("Skip goes to feedback without an answer", async () => {
    const r = await makeRig({ stage: "fluent" });
    await r.machine.start();
    await toQuestion(r);
    await answerItem(r);
    r.machine.skip();
    expect(r.machine.state).toMatchObject({ kind: "feedback", canRetry: true });
    const attempts = attemptsOf(await logOf(r));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.selfAssessment).toBeUndefined();
    expect(attempts[0]?.v).toBe(2);
  });

  it("pausing writes the attempt without an answer and resumes on the feedback", async () => {
    const r = await makeRig({ stage: "fluent" });
    await r.machine.start();
    await toQuestion(r);
    await answerItem(r);
    r.machine.pause();
    expect(r.machine.state).toMatchObject({ kind: "paused", resumeTo: "feedback" });
    await r.machine.settled();
    const written = attemptsOf(await r.h.store.list());
    expect(written).toHaveLength(1);
    expect(written[0]?.selfAssessment).toBeUndefined();
    r.machine.resume();
    expect(r.machine.state).toMatchObject({ kind: "feedback", canRetry: false });
    // Answering now does nothing: the attempt is already written.
    r.machine.selfAssess("right");
    expect(attemptsOf(await logOf(r))[0]?.selfAssessment).toBeUndefined();
  });

  it("finishing on the question writes the attempt", async () => {
    const r = await makeRig({ stage: "fluent" });
    await r.machine.start();
    await toQuestion(r);
    await answerItem(r);
    r.machine.finish();
    await until(r, (s) => s.kind === "summary");
    const attempts = attemptsOf(await r.h.store.list());
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.selfAssessment).toBeUndefined();
  });
});
