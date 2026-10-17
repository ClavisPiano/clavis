import type { FakeInputAdapter } from "@clavis/audio";
import type { LearnerState, LearningEvent } from "@clavis/core";
import { describe, expect, it } from "vitest";
import { SessionMachine, type SessionState } from "./machine";
import { T0, makeHarness, noteAt, playCorrect, singCorrect, type Harness } from "./test-harness";

/* Drives the machine with a manual clock, a fake player and the real composer, generators,
   scorer and learner state. Time only moves through `advance`. */

async function until(
  h: Harness,
  pred: (s: SessionState) => boolean,
  maxMs = 60_000,
): Promise<SessionState> {
  for (let t = 0; t < maxMs && !pred(h.machine.state); t += 50) await h.advance(50);
  if (!pred(h.machine.state)) {
    throw new Error(`condition not reached, stuck in ${JSON.stringify(h.machine.state)}`);
  }
  return h.machine.state;
}

const isKind =
  (kind: SessionState["kind"]) =>
  (s: SessionState): boolean =>
    s.kind === kind;

const isListening = (phase?: "sing" | "play") => (s: SessionState) =>
  s.kind === "listening" && (phase === undefined || s.phase === phase);

/** Answer the current listening phase correctly through the right adapter. */
async function answer(h: Harness, singAdapter?: FakeInputAdapter): Promise<void> {
  const s = h.machine.state;
  if (s.kind !== "listening") throw new Error("not listening");
  const expected = h.machine.debug().expected;
  if (!expected) throw new Error("no expected response");
  const start = h.clock.ctxMs + 200;
  if (s.phase === "sing") singCorrect(singAdapter ?? h.input, expected, start);
  else playCorrect(h.input, expected, start);
  await h.machine.settled();
}

/** From the item's presenting state to its feedback, answering every phase correctly. */
async function playItem(h: Harness, singAdapter?: FakeInputAdapter): Promise<void> {
  for (;;) {
    const s = await until(
      h,
      (x) => x.kind === "listening" || x.kind === "feedback" || x.kind === "selfAssess",
    );
    if (s.kind === "feedback" || s.kind === "selfAssess") return;
    await answer(h, singAdapter);
    const now = h.machine.state.kind;
    if (now === "feedback" || now === "selfAssess") return;
    // Wait for a state change out of the phase we just answered (sequences need a quiet moment).
    const phase = s.kind === "listening" ? s.phase : undefined;
    await until(h, (x) => !(x.kind === "listening" && x.phase === phase));
  }
}

async function types(h: Harness): Promise<string[]> {
  return (await h.log()).map((e) => e.type);
}

function byType<T extends LearningEvent["type"]>(
  events: LearningEvent[],
  type: T,
): Extract<LearningEvent, { type: T }>[] {
  return events.filter((e): e is Extract<LearningEvent, { type: T }> => e.type === type);
}

/** Collapse repeats so state traces are readable. */
function kinds(states: SessionState[]): string[] {
  const out: string[] = [];
  for (const s of states) {
    const label = s.kind === "listening" ? `listening-${s.phase}` : s.kind;
    if (out[out.length - 1] !== label) out.push(label);
  }
  return out;
}

async function runWholeSession(h: Harness, singAdapter?: FakeInputAdapter): Promise<void> {
  await h.machine.start();
  for (let guard = 0; guard < 40 && h.machine.state.kind !== "summary"; guard++) {
    const s = h.machine.state;
    if (s.kind === "orient" || s.kind === "intro") h.machine.next();
    else if (s.kind === "presenting" || s.kind === "listening") await playItem(h, singAdapter);
    else if (s.kind === "feedback") h.machine.next();
    await h.advance(50);
  }
}

describe("happy path", () => {
  it("runs start, orient, intro, items and summary with the exact event sequence", async () => {
    const h = await makeHarness({ budgetSec: 90 });
    await runWholeSession(h);

    expect(h.machine.state.kind).toBe("summary");
    expect(kinds(h.states)).toEqual([
      "preparing",
      "orient",
      "intro",
      "presenting",
      "listening-play",
      "feedback",
      "presenting",
      "listening-play",
      "feedback",
      "presenting",
      "listening-play",
      "feedback",
      "summary",
    ]);

    expect(await types(h)).toEqual([
      "session.started",
      "node.introduced",
      "item.presented",
      "attempt.completed",
      "item.presented",
      "attempt.completed",
      "item.presented",
      "attempt.completed",
      "session.ended",
    ]);

    const events = await h.log();
    const started = byType(events, "session.started")[0];
    expect(started).toMatchObject({
      deviceId: "device-1",
      mode: "instrument",
      budgetSec: 90,
      key: { tonic: "C", mode: "major" },
      tzOffsetMin: 600,
      contentVersion: h.graph.contentVersion,
      sessionId: h.machine.sessionId,
    });
    expect(byType(events, "node.introduced")[0]).toMatchObject({
      nodeId: "ear.degrees.major.135",
      sessionId: h.machine.sessionId,
    });

    const presented = byType(events, "item.presented");
    expect(presented.map((p) => [p.generator, p.block, p.isNew])).toEqual([
      ["degreeSing", "ear", true],
      ["degreeId", "ear", true],
      ["degreeSing", "ear", true],
    ]);
    expect(presented[0]?.presentation).toMatchObject({ tonic: "C", mode: "major" });
    expect(presented[0]?.itemId).toBe("ear.degrees.major.135|degree=1");

    const attempts = byType(events, "attempt.completed");
    expect(attempts).toHaveLength(3);
    expect(attempts.map((a) => a.outcome.correct)).toEqual([true, true, true]);
    expect(attempts.every((a) => a.subScores?.play === 1 && a.subScores.sing === undefined)).toBe(
      true,
    );
    expect(attempts.every((a) => a.inputSource === "mic")).toBe(true);
    expect(attempts[0]).toMatchObject({
      sessionId: h.machine.sessionId,
      itemId: presented[0]?.itemId,
      nodeId: "ear.degrees.major.135",
    });
    expect(byType(events, "session.ended")[0]).toMatchObject({
      sessionId: h.machine.sessionId,
      reason: "completed",
    });

    const s = h.machine.state;
    if (s.kind !== "summary") throw new Error("expected summary");
    expect(s.summary).toMatchObject({ reason: "completed", items: 3, correct: 3, accuracy: 1 });
    expect(s.summary.nodeChanges).toEqual([
      {
        nodeId: "ear.degrees.major.135",
        title: "Degrees 1, 3, 5",
        from: "available",
        to: "learning",
      },
    ]);
  });

  it("orient is unscored and not logged, and the intro shows title and description", async () => {
    const h = await makeHarness({ budgetSec: 90 });
    await h.machine.start();
    expect(h.machine.state).toMatchObject({ kind: "orient", playing: true });
    expect(h.player.plays).toHaveLength(1);
    expect((await types(h)).filter((t) => t === "item.presented")).toHaveLength(0);
    await h.advance(10_000);
    expect(h.machine.state).toMatchObject({ kind: "orient", playing: false });
    h.machine.next();
    expect(h.machine.state).toMatchObject({
      kind: "intro",
      nodeId: "ear.degrees.major.135",
      title: "Degrees 1, 3, 5",
    });
    h.machine.next();
    expect(h.machine.state.kind).toBe("presenting");
  });

  it("a stored learner day and key feed the composer (tz sign, content version)", async () => {
    const h = await makeHarness({ budgetSec: 90 });
    await h.machine.start();
    expect(h.machine.plan?.budgetSec).toBe(90);
    const started = byType(await h.log(), "session.started")[0];
    expect(started?.at).toBe(T0 + 5000);
  });
});

describe("played answers", () => {
  it("prompts to play, ignores notes before the gate, and scores the played part", async () => {
    const h = await makeHarness({ budgetSec: 90 });
    await h.machine.start();
    h.machine.next();
    h.machine.next();
    const first = await until(h, isListening("play"));
    expect(first).toMatchObject({ phase: "play", phaseIndex: 0, phaseCount: 1, prompt: "Play it" });
    await answer(h);
    await until(h, isKind("feedback"));
    const attempt = byType(await h.log(), "attempt.completed")[0];
    expect(attempt?.subScores).toEqual({ play: 1 });
    expect(attempt?.outcome.correct).toBe(true);
    expect(attempt?.errors).toBeUndefined();
  });

  it("a wrong played note is incorrect, says what was played and gives the answer", async () => {
    const h = await makeHarness({ budgetSec: 90 });
    await h.machine.start();
    h.machine.next();
    h.machine.next();
    await until(h, isListening("play"));
    const expected = h.machine.debug().expected;
    const target = expected?.play?.kind === "pitchClass" ? expected.play.targetMidi : 60;
    h.input.emitNote(noteAt(target + 1, h.clock.ctxMs + 200, "mic"));
    await h.machine.settled();
    await until(h, isKind("feedback"));
    const attempt = byType(await h.log(), "attempt.completed")[0];
    expect(attempt?.outcome.correct).toBe(false);
    expect(attempt?.subScores?.play).toBe(0);
    expect(attempt?.errors?.[0]?.code).toMatch(/^degree\.confusion\./);
    const fb = h.machine.state;
    if (fb.kind !== "feedback") throw new Error("expected feedback");
    expect(fb.feedback.correct).toBe(false);
    expect(fb.feedback.lines[0]).toMatch(/^You played /);
    expect(fb.feedback.answer).toMatch(/^The note was \d, which is [A-G][b#]? in C major\.$/);
  });

  it("sets the item's input range while the play phase listens, and clears it after (T3.12)", async () => {
    const h = await makeHarness({ budgetSec: 90 });
    const range = { low: 36, high: 64 };
    const generate = h.deps.generate.bind(h.deps);
    h.deps.generate = (item, ctx) => ({ ...generate(item, ctx), inputRange: range });
    await h.machine.start();
    h.machine.next();
    h.machine.next();
    await until(h, isListening("play"));
    expect(h.input.expectedRange).toEqual(range);
    await answer(h);
    await until(h, isKind("feedback"));
    expect(h.input.expectedRange).toBeNull();
    expect(h.input.expectedRangeCalls.filter((r) => r !== null)).toEqual([range]);
  });

  it("never sets a range for items without inputRange", async () => {
    const h = await makeHarness({ budgetSec: 90 });
    await h.machine.start();
    h.machine.next();
    h.machine.next();
    await until(h, isListening("play"));
    await answer(h);
    await until(h, isKind("feedback"));
    expect(h.input.expectedRangeCalls.every((r) => r === null)).toBe(true);
  });

  it("clears the range when the item is interrupted by a pause", async () => {
    const h = await makeHarness({ budgetSec: 90 });
    const range = { low: 36, high: 64 };
    const generate = h.deps.generate.bind(h.deps);
    h.deps.generate = (item, ctx) => ({ ...generate(item, ctx), inputRange: range });
    await h.machine.start();
    h.machine.next();
    h.machine.next();
    await until(h, isListening("play"));
    expect(h.input.expectedRange).toEqual(range);
    h.machine.pause();
    expect(h.input.expectedRange).toBeNull();
  });

  it("the Done button ends the phase early", async () => {
    const h = await makeHarness({ budgetSec: 90 });
    await h.machine.start();
    h.machine.next();
    h.machine.next();
    await until(h, isListening("play"));
    h.machine.answerDone();
    await h.machine.settled();
    expect(h.machine.state.kind).toBe("feedback");
    const attempt = byType(await h.log(), "attempt.completed")[0];
    expect(attempt?.outcome.correct).toBe(false);
    expect(attempt?.errors?.map((e) => e.code)).toContain("response.timeout");
  });
});

describe("Away mode", () => {
  it("has no orient block and taps every answer", async () => {
    const h = await makeHarness({ mode: "away", budgetSec: 90 });
    await h.machine.start();
    expect(h.machine.state.kind).toBe("intro");
    expect(h.player.plays).toHaveLength(0);
    h.machine.next();
    const tap = await until(h, isListening());
    expect(tap).toMatchObject({ phase: "play", phaseCount: 1, prompt: "Tap it on the keyboard" });
    await answer(h);
    await until(h, isKind("feedback"));
    h.machine.next();
    await until(h, isListening());
    await answer(h);
    await until(h, isKind("feedback"));

    const events = await h.log();
    expect(byType(events, "session.started")[0]?.mode).toBe("away");
    const attempts = byType(events, "attempt.completed");
    expect(attempts.map((a) => a.inputSource)).toEqual(["tap", "tap"]);
    expect(attempts.every((a) => a.subScores?.play === 1)).toBe(true);
    expect(h.player.plays.every((p) => p.spec.events.some((e) => e.role === "cadence"))).toBe(true);
  });

  it("never creates a mic input for sung parts", async () => {
    let created = 0;
    const h = await makeHarness({ mode: "away", budgetSec: 90, withSingInput: false });
    h.deps.createSingInput = () => {
      created++;
      return h.singInput;
    };
    await h.machine.start();
    expect(created).toBe(0);
  });
});

describe("MIDI keyboard at the piano", () => {
  it("leaves the mic closed when no item needs singing", async () => {
    let created = 0;
    const h = await makeHarness({ budgetSec: 90, inputSource: "midi", withSingInput: false });
    h.deps.createSingInput = () => {
      created++;
      return h.singInput;
    };
    await h.machine.start();
    expect(created).toBe(0);
  });
});

describe("stimulus gating (T1.6)", () => {
  /** The right note, as the item expects it. */
  const targetOf = (h: Harness): number => {
    const play = h.machine.debug().expected?.play;
    if (play?.kind !== "pitchClass") throw new Error("expected a pitch class target");
    return play.targetMidi;
  };

  it("drops input during the stimulus and the tail, then accepts answers", async () => {
    const h = await makeHarness({ budgetSec: 90, headphones: true });
    await h.machine.start();
    h.machine.next();
    h.machine.next();
    expect(h.machine.state.kind).toBe("presenting");
    // The adapter is gated shut while the stimulus plays.
    expect(h.input.emitNote(noteAt(60, h.clock.ctxMs, "mic"))).toBeUndefined();
    expect(h.input.emitFrame({ hz: 261.63, atMs: h.clock.ctxMs })).toBeUndefined();

    await until(h, isListening("play"));
    const end = h.machine.debug().stimulusEndMs ?? 0;
    expect(h.clock.ctxMs).toBe(end + 150);

    // Late events stamped inside the stimulus or the tail are dropped by the machine.
    const target = targetOf(h);
    h.input.emitNote(noteAt(target, end - 500, "mic"));
    h.input.emitNote(noteAt(target, end + 20, "mic"));
    await h.machine.settled();
    expect(h.machine.state).toMatchObject({ kind: "listening", phase: "play" });

    // The same pitch after the tail is accepted.
    h.input.emitNote(noteAt(target, end + 160, "mic"));
    await h.machine.settled();
    await until(h, isKind("feedback"));
  });

  it("uses a longer tail without headphones", async () => {
    const h = await makeHarness({ budgetSec: 90, headphones: false });
    await h.machine.start();
    h.machine.next();
    h.machine.next();
    await until(h, isListening("play"));
    const end = h.machine.debug().stimulusEndMs ?? 0;
    expect(h.clock.ctxMs).toBe(end + 400);
    h.input.emitNote(noteAt(targetOf(h), end + 300, "mic"));
    await h.machine.settled();
    expect(h.machine.state).toMatchObject({ kind: "listening", phase: "play" });
  });

  it("the input is gated again whenever the stimulus plays", async () => {
    const h = await makeHarness({ budgetSec: 90 });
    await h.machine.start();
    h.machine.next();
    h.machine.next();
    await until(h, isListening("play"));
    // Listening: the adapter delivers.
    expect(h.input.emitNote(noteAt(60, h.clock.ctxMs + 500, "mic"))).toBeDefined();
    h.machine.answerDone();
    await until(h, isKind("feedback"));
    // Feedback: gated shut again.
    expect(h.input.emitNote(noteAt(60, h.clock.ctxMs, "mic"))).toBeUndefined();
  });
});

describe("latency offsets", () => {
  it("subtracts the tap offset from event times", async () => {
    const h = await makeHarness({ mode: "away", budgetSec: 90, latency: { tapMs: 50 } });
    await h.machine.start();
    h.machine.next();
    await until(h, isListening("play"));
    const end = h.machine.debug().stimulusEndMs ?? 0;
    const play = h.machine.debug().expected?.play;
    if (play?.kind !== "pitchClass") throw new Error("expected a pitch class target");
    // Reported 850 ms after the stimulus; the tap adds 50 ms, so the real onset was at +800.
    h.input.emitNote(noteAt(play.targetMidi, end + 850, "tap"));
    await h.machine.settled();
    await until(h, isKind("feedback"));
    const attempts = byType(await h.log(), "attempt.completed");
    expect(attempts[0]?.outcome.latencyMs).toBeCloseTo(800, 0);
  });

  it("leaves MIDI event times alone", async () => {
    const h = await makeHarness({
      budgetSec: 90,
      inputSource: "midi",
      latency: { tapMs: 50, micMs: 100 },
    });
    await h.machine.start();
    h.machine.next();
    h.machine.next();
    await until(h, isListening("play"));
    const end = h.machine.debug().stimulusEndMs ?? 0;
    const play = h.machine.debug().expected?.play;
    if (play?.kind !== "pitchClass") throw new Error("expected a pitch class target");
    h.input.emitNote(noteAt(play.targetMidi, end + 850, "midi"));
    await h.machine.settled();
    await until(h, isKind("feedback"));
    const attempts = byType(await h.log(), "attempt.completed");
    expect(attempts[0]?.outcome.latencyMs).toBeCloseTo(850, 0);
    expect(attempts[0]?.inputSource).toBe("midi");
    expect(attempts[0]?.outcome.correct).toBe(true);
  });

  it("subtracts the mic offset from event times", async () => {
    const h = await makeHarness({ budgetSec: 90, latency: { micMs: 100 }, headphones: true });
    await h.machine.start();
    h.machine.next();
    h.machine.next();
    await until(h, isListening("play"));
    const end = h.machine.debug().stimulusEndMs ?? 0;
    const play = h.machine.debug().expected?.play;
    if (play?.kind !== "pitchClass") throw new Error("expected a pitch class target");
    h.input.emitNote(noteAt(play.targetMidi, end + 1100, "mic"));
    await h.machine.settled();
    await until(h, isKind("feedback"));
    const attempts = byType(await h.log(), "attempt.completed");
    expect(attempts[0]?.outcome.latencyMs).toBeCloseTo(1000, 0);
  });

  it("a corrected time inside the gate is dropped", async () => {
    const h = await makeHarness({ budgetSec: 90, latency: { micMs: 200 }, headphones: true });
    await h.machine.start();
    h.machine.next();
    h.machine.next();
    await until(h, isListening("play"));
    const end = h.machine.debug().stimulusEndMs ?? 0;
    const play = h.machine.debug().expected?.play;
    if (play?.kind !== "pitchClass") throw new Error("expected a pitch class target");
    // Reported at +250 ms, corrected to +50 ms: inside the 150 ms tail.
    h.input.emitNote(noteAt(play.targetMidi, end + 250, "mic"));
    await h.machine.settled();
    expect(h.machine.state).toMatchObject({ kind: "listening", phase: "play" });
  });
});

describe("response completion", () => {
  it("times the item out when the response window passes with no answer", async () => {
    const h = await makeHarness({ budgetSec: 90 });
    await h.machine.start();
    h.machine.next();
    h.machine.next();
    await until(h, isListening("play"));
    const window = h.machine.debug().expected?.responseWindowMs ?? 0;
    const end = h.machine.debug().stimulusEndMs ?? 0;
    await h.advance(end + window - h.clock.ctxMs - 100);
    expect(h.machine.state).toMatchObject({ kind: "listening", phase: "play" });
    await h.advance(300);
    expect(h.machine.state.kind).toBe("feedback");
    const attempt = byType(await h.log(), "attempt.completed")[0];
    expect(attempt?.errors?.map((e) => e.code)).toContain("response.timeout");
  });
});

describe("skip", () => {
  it("logs an incorrect attempt with the full window as latency", async () => {
    const h = await makeHarness({ budgetSec: 90 });
    await h.machine.start();
    h.machine.next();
    h.machine.next();
    await until(h, isListening("play"));
    const window = h.machine.debug().expected?.responseWindowMs;
    h.machine.skip();
    await h.machine.settled();
    expect(h.machine.state.kind).toBe("feedback");
    const attempt = byType(await h.log(), "attempt.completed")[0];
    expect(attempt).toMatchObject({
      outcome: { correct: false, latencyMs: window, retries: 0 },
      errors: [{ code: "response.skipped" }],
      inputSource: "mic",
    });
    expect(attempt?.subScores).toBeUndefined();
    const state = h.machine.state;
    if (state.kind !== "feedback") throw new Error("expected feedback");
    expect(state.feedback.lines).toEqual(["Skipped"]);
  });

  it("can skip while the stimulus is still playing", async () => {
    const h = await makeHarness({ budgetSec: 90 });
    await h.machine.start();
    h.machine.next();
    h.machine.next();
    expect(h.machine.state.kind).toBe("presenting");
    h.machine.skip();
    await h.machine.settled();
    expect(await types(h)).toEqual([
      "session.started",
      "node.introduced",
      "item.presented",
      "attempt.completed",
    ]);
    // The stimulus was silenced and no stale timer opens listening afterwards.
    await h.advance(20_000);
    expect(h.machine.state.kind).toBe("feedback");
  });
});

describe("feedback fading", () => {
  async function withNodeState(
    state: "learning" | "fluent" | "mastered",
  ): Promise<{ h: Harness; machine: SessionMachine; states: SessionState[] }> {
    const h = await makeHarness({ budgetSec: 90 });
    const real = (): LearnerState => h.deps.getState();
    // The composer sees the real state; the override applies once the first item is presented.
    let active = false;
    const machine = new SessionMachine({
      ...h.deps,
      getState: () => {
        const s = real();
        if (!active) return s;
        return {
          ...s,
          nodes: {
            ...s.nodes,
            "ear.degrees.major.135": { ...s.nodes["ear.degrees.major.135"], state },
          },
        };
      },
    });
    const states: SessionState[] = [];
    machine.subscribe((s) => {
      states.push(s);
      if (s.kind === "presenting") active = true;
    });
    return { h: { ...h, machine, states }, machine, states };
  }

  it("mastered: a correct attempt shows a tick and advances by itself", async () => {
    const { h } = await withNodeState("mastered");
    await h.machine.start();
    h.machine.next();
    h.machine.next();
    await playItem(h);
    // The first fluent or mastered answer of a session is self-assessed (R28) before feedback.
    expect(h.machine.state.kind).toBe("selfAssess");
    h.machine.selfAssess("right");
    const fb = h.machine.state;
    if (fb.kind !== "feedback") throw new Error("expected feedback");
    expect(fb.feedback).toMatchObject({ correct: true, detailed: false, autoAdvance: true });
    await h.advance(799);
    expect(h.machine.state.kind).toBe("feedback");
    await h.advance(60);
    expect(h.machine.state.kind).toBe("presenting");
  });

  it("mastered: auto-advance still happens after a pause in feedback", async () => {
    const { h } = await withNodeState("mastered");
    await h.machine.start();
    h.machine.next();
    h.machine.next();
    await playItem(h);
    h.machine.selfAssess("right");
    expect(h.machine.state).toMatchObject({ kind: "feedback", feedback: { autoAdvance: true } });
    h.machine.pause();
    await h.advance(5000);
    expect(h.machine.state.kind).toBe("paused");
    h.machine.resume();
    expect(h.machine.state.kind).toBe("feedback");
    await h.advance(860);
    expect(h.machine.state.kind).toBe("presenting");
  });

  it("mastered: an error shows the detail", async () => {
    const { h } = await withNodeState("mastered");
    await h.machine.start();
    h.machine.next();
    h.machine.next();
    await until(h, isListening("play"));
    h.machine.skip();
    await h.machine.settled();
    const fb = h.machine.state;
    if (fb.kind !== "feedback") throw new Error("expected feedback");
    expect(fb.feedback).toMatchObject({ correct: false, detailed: true, autoAdvance: false });
    await h.advance(5000);
    expect(h.machine.state.kind).toBe("feedback");
  });

  it("fluent: every second attempt gets the detail", async () => {
    const { h } = await withNodeState("fluent");
    await h.machine.start();
    h.machine.next();
    h.machine.next();
    await playItem(h);
    h.machine.selfAssess("wrong");
    const first = h.machine.state;
    if (first.kind !== "feedback") throw new Error("expected feedback");
    expect(first.feedback.detailed).toBe(true);
    expect(first.feedback.autoAdvance).toBe(false);
    h.machine.next();
    await playItem(h);
    const second = h.machine.state;
    if (second.kind !== "feedback") throw new Error("expected feedback");
    expect(second.feedback.detailed).toBe(false);
    expect(second.feedback.autoAdvance).toBe(true);
  });

  it("learning: every attempt is detailed and listing at most two issues", async () => {
    const { h } = await withNodeState("learning");
    await h.machine.start();
    h.machine.next();
    h.machine.next();
    await until(h, isListening("play"));
    h.machine.answerDone();
    h.machine.answerDone();
    await h.machine.settled();
    const fb = h.machine.state;
    if (fb.kind !== "feedback") throw new Error("expected feedback");
    expect(fb.feedback.detailed).toBe(true);
    expect(fb.feedback.lines.length).toBeGreaterThan(0);
    expect(fb.feedback.lines.length).toBeLessThanOrEqual(2);
    expect(fb.canReplay).toBe(true);
  });
});

describe("replay", () => {
  it("plays the reference target and then the learner's attempt", async () => {
    const h = await makeHarness({ budgetSec: 90 });
    await h.machine.start();
    h.machine.next();
    h.machine.next();
    await playItem(h);
    const before = h.player.plays.length;
    h.machine.replay();
    expect(h.player.plays).toHaveLength(before + 1);
    const spec = h.player.plays[before]?.spec;
    const roles = spec?.events.map((e) => e.role);
    expect(roles?.filter((r) => r === "target")).toHaveLength(1);
    expect(roles?.some((r) => r === "cadence")).toBe(false);
    expect(spec?.events.some((e) => e.role === undefined)).toBe(true);
    // Replay is silent input-wise: the adapter stays gated.
    expect(h.input.emitNote(noteAt(60, h.clock.ctxMs, "mic"))).toBeUndefined();
  });
});

describe("backgrounding", () => {
  it("pauses during listening and resumes by replaying the stimulus without a second presented event", async () => {
    const h = await makeHarness({ budgetSec: 90 });
    await h.machine.start();
    h.machine.next();
    h.machine.next();
    await until(h, isListening("play"));
    const stopsBefore = h.player.stops;
    const playsBefore = h.player.plays.length;
    h.machine.pause();
    expect(h.machine.state).toEqual({ kind: "paused", resumeTo: "listening" });
    expect(h.player.stops).toBeGreaterThan(stopsBefore);
    expect(h.input.emitNote(noteAt(60, h.clock.ctxMs, "mic"))).toBeUndefined();
    // Nothing fires while paused.
    await h.advance(60_000);
    expect(h.machine.state.kind).toBe("paused");
    expect(h.clock.pending()).toBe(0);

    h.machine.resume();
    expect(h.machine.state.kind).toBe("presenting");
    expect(h.player.plays).toHaveLength(playsBefore + 1);
    await until(h, isListening("play"));
    await answer(h);
    await until(h, isKind("feedback"));
    const presented = byType(await h.log(), "item.presented");
    expect(presented).toHaveLength(1);
    expect(byType(await h.log(), "attempt.completed")).toHaveLength(1);
  });

  it("does not count paused time against the budget", async () => {
    const h = await makeHarness({ budgetSec: 90 });
    await h.machine.start();
    h.machine.next();
    await h.advance(2000);
    const before = h.machine.elapsedSec();
    h.machine.pause();
    await h.advance(100_000);
    h.machine.resume();
    expect(h.machine.elapsedSec()).toBeCloseTo(before, 0);
  });

  it("pausing in feedback returns to the same feedback", async () => {
    const h = await makeHarness({ budgetSec: 90 });
    await h.machine.start();
    h.machine.next();
    h.machine.next();
    await playItem(h);
    const feedback = h.machine.state;
    h.machine.pause();
    expect(h.machine.state.kind).toBe("paused");
    h.machine.resume();
    // Pausing writes the held-back attempt, so Try again is no longer offered.
    expect(h.machine.state).toEqual({ ...feedback, canRetry: false });
  });

  it("pausing during orient restarts the orient audio on resume", async () => {
    const h = await makeHarness({ budgetSec: 90 });
    await h.machine.start();
    h.machine.pause();
    h.machine.resume();
    expect(h.machine.state).toMatchObject({ kind: "orient", playing: true });
    expect(h.player.plays).toHaveLength(2);
  });
});

describe("open sessions", () => {
  it("closes a session left open by a reload as abandoned before starting a new one", async () => {
    const h0 = await makeHarness({ budgetSec: 90 });
    await h0.machine.start();
    h0.machine.next();
    h0.machine.next();
    await until(h0, isListening("play"));
    // The page is reloaded here: the store keeps a session.started without a session.ended.
    const history = await h0.log();
    const orphan = byType(history, "session.started")[0]?.sessionId ?? "";
    expect(orphan).not.toBe("");

    const { findOpenSessions } = await import("./open");
    expect(findOpenSessions(history, "device-1")).toEqual([orphan]);
    expect(findOpenSessions(history, "other-device")).toEqual([]);

    const h = await makeHarness({
      budgetSec: 90,
      idSalt: 77,
      history,
      openSessions: () => Promise.resolve(findOpenSessions(history, "device-1")),
    });
    await h.machine.start();
    const events = await h.log();
    const typeList = events.map((e) => e.type);
    const endedIdx = typeList.lastIndexOf("session.ended");
    const startedIdx = typeList.lastIndexOf("session.started");
    expect(endedIdx).toBeGreaterThan(-1);
    expect(endedIdx).toBeLessThan(startedIdx);
    const ended = byType(events, "session.ended").at(-1);
    expect(ended).toMatchObject({ sessionId: orphan, reason: "abandoned" });
    expect(findOpenSessions(events, "device-1")).toEqual([h.machine.sessionId]);
  });
});

describe("headphones prompt", () => {
  it("asks once when the mic is used and the answer is unknown, then remembers", async () => {
    const saved: boolean[] = [];
    const h = await makeHarness({
      budgetSec: 90,
      headphones: undefined,
      askHeadphones: true,
      saveHeadphones: (v) => {
        saved.push(v);
        return Promise.resolve();
      },
    });
    const started = h.machine.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.machine.state.kind).toBe("headphones");
    h.machine.answerHeadphones(false);
    await started;
    expect(saved).toEqual([false]);
    expect(h.machine.headphones).toBe(false);
    expect(h.machine.state.kind).toBe("orient");
    // No headphones selects the long gate tail.
    h.machine.next();
    h.machine.next();
    await until(h, isListening("play"));
    expect(h.clock.ctxMs).toBe((h.machine.debug().stimulusEndMs ?? 0) + 400);
  });

  it("does not ask when the answer is known or the input is not the mic", async () => {
    const known = await makeHarness({ budgetSec: 90, headphones: true, askHeadphones: true });
    await known.machine.start();
    expect(kinds(known.states)).not.toContain("headphones");

    const tap = await makeHarness({
      mode: "away",
      budgetSec: 90,
      headphones: undefined,
      askHeadphones: true,
      withSingInput: false,
    });
    // Tap input and no sung item reaches the mic: here a sung item is planned but there is no
    // factory, so the mic is never used and the question is skipped.
    await tap.machine.start();
    expect(kinds(tap.states)).not.toContain("headphones");
  });
});

describe("end of session", () => {
  it("ends when the budget is overrun by more than one item", async () => {
    const h = await makeHarness({ budgetSec: 90 });
    await h.machine.start();
    h.machine.next();
    h.machine.next();
    await playItem(h);
    // Learner dawdles far beyond the budget before the next item.
    await h.advance(1000);
    h.clock.ctxMs += 300_000;
    h.machine.next();
    await h.machine.settled();
    expect(h.machine.state.kind).toBe("summary");
    const events = await h.log();
    expect(byType(events, "attempt.completed")).toHaveLength(1);
    expect(byType(events, "session.ended")[0]?.reason).toBe("completed");
  });

  it("Finish ends as completed after an attempt and abandoned before any", async () => {
    const a = await makeHarness({ budgetSec: 90 });
    await a.machine.start();
    a.machine.next();
    a.machine.next();
    await playItem(a);
    a.machine.finish();
    await a.machine.settled();
    expect(byType(await a.log(), "session.ended")[0]?.reason).toBe("completed");
    expect(a.player.stops).toBeGreaterThan(0);

    const b = await makeHarness({ budgetSec: 90 });
    await b.machine.start();
    b.machine.finish();
    await b.machine.settled();
    expect(byType(await b.log(), "session.ended")[0]?.reason).toBe("abandoned");
    const s = b.machine.state;
    if (s.kind !== "summary") throw new Error("expected summary");
    expect(s.summary).toMatchObject({ items: 0, accuracy: 0, reason: "abandoned" });
  });

  it("shows an error and writes nothing when the input cannot start", async () => {
    const h = await makeHarness({ budgetSec: 90 });
    h.input.start = () => Promise.reject(new Error("Permission denied"));
    await h.machine.start();
    expect(h.machine.state).toMatchObject({ kind: "error" });
    const s = h.machine.state;
    if (s.kind !== "error") throw new Error("expected error");
    expect(s.message).toContain("Permission denied");
    expect(await types(h)).toEqual([]);
  });
});

describe("practice session (T2.15)", () => {
  it("logs session.started with practice, leaves cards alone and still records attempts", async () => {
    const first = await makeHarness({ budgetSec: 90 });
    await runWholeSession(first);
    const history = await first.log();
    const cardsBefore = JSON.stringify(first.service.state.cards);
    const attemptsBefore = Object.values(first.service.state.attempts).flat().length;
    expect(Object.keys(first.service.state.cards).length).toBeGreaterThan(0);

    const h = await makeHarness({ budgetSec: 90, practice: true, history, idSalt: 77 });
    await runWholeSession(h);
    expect(h.machine.state.kind).toBe("summary");
    expect(h.machine.plan?.practice).toBe(true);
    expect(h.machine.plan?.introductions).toEqual([]);

    const events = (await h.log()).filter((e) => !history.some((o) => o.id === e.id));
    const started = byType(events, "session.started");
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ v: 2, practice: true });
    expect(byType(events, "node.introduced")).toEqual([]);
    expect(byType(events, "item.presented").every((e) => !e.isNew)).toBe(true);
    expect(byType(events, "attempt.completed").length).toBeGreaterThan(0);

    expect(JSON.stringify(h.service.state.cards)).toBe(cardsBefore);
    expect(Object.values(h.service.state.attempts).flat().length).toBeGreaterThan(attemptsBefore);
  });

  it("normal sessions write session.started v2 without practice", async () => {
    const h = await makeHarness({ budgetSec: 90 });
    await h.machine.start();
    const started = byType(await h.log(), "session.started")[0];
    expect(started?.v).toBe(2);
    expect(started?.practice).toBeUndefined();
  });

  it("says so when none of the chosen skills can be practised", async () => {
    const h = await makeHarness({ budgetSec: 90, practice: true, skills: ["read.bass.landmarks"] });
    await h.machine.start();
    const state = h.machine.state;
    if (state.kind !== "error") throw new Error("expected an error state");
    expect(state.message).toContain("skills you chose");
  });

  it("an empty practice plan ends with a friendly message and writes no events", async () => {
    const h = await makeHarness({ budgetSec: 90, practice: true });
    await h.machine.start();
    const s = h.machine.state;
    expect(s.kind).toBe("error");
    if (s.kind === "error") expect(s.message).toMatch(/Nothing to practise yet/);
    expect(await h.log()).toEqual([]);
  });
});

describe("keep going and learn more", () => {
  async function runLong(h: Harness): Promise<void> {
    await h.machine.start();
    for (let guard = 0; guard < 600 && h.machine.state.kind !== "summary"; guard++) {
      const s = h.machine.state;
      if (s.kind === "orient" || s.kind === "intro") h.machine.next();
      else if (s.kind === "presenting" || s.kind === "listening") await playItem(h);
      else if (s.kind === "feedback") h.machine.next();
      await h.advance(50);
    }
  }

  it("plays the same item more than once in a practice plan, with distinct attempts and untouched cards", async () => {
    const first = await makeHarness({ budgetSec: 90 });
    await runWholeSession(first);
    const history = await first.log();
    const cardsBefore = JSON.stringify(first.service.state.cards);

    const h = await makeHarness({ budgetSec: 400, practice: true, history, idSalt: 91 });
    await runLong(h);
    expect(h.machine.state.kind).toBe("summary");
    const planned = [...(h.machine.plan?.blocks.ear ?? []), ...(h.machine.plan?.blocks.read ?? [])];
    const ids = planned.map((p) => p.itemId);
    expect(new Set(ids).size).toBeLessThan(ids.length);
    ids.forEach((id, i) => {
      expect(id).not.toBe(ids[i - 1]);
    });

    const events = (await h.log()).filter((e) => !history.some((o) => o.id === e.id));
    const attempts = byType(events, "attempt.completed");
    expect(attempts.length).toBeGreaterThan(planned.length / 2);
    expect(new Set(attempts.map((a) => a.id)).size).toBe(attempts.length);
    expect(byType(events, "item.presented").length).toBe(attempts.length);
    const summary = h.machine.state;
    if (summary.kind === "summary") expect(summary.summary.items).toBe(attempts.length);
    expect(JSON.stringify(h.service.state.cards)).toBe(cardsBefore);
  });

  it("extraNewItems introduces new items after the daily cap is reached", async () => {
    const first = await makeHarness({ budgetSec: 90 });
    await runWholeSession(first);
    const history = await first.log();
    const plain = await makeHarness({ budgetSec: 90, history, idSalt: 55 });
    await plain.machine.start();
    const more = await makeHarness({ budgetSec: 90, history, idSalt: 66, extraNewItems: 5 });
    await more.machine.start();
    const fresh = (h: Harness) =>
      [...(h.machine.plan?.blocks.ear ?? []), ...(h.machine.plan?.blocks.read ?? [])].filter(
        (i) => i.isNew,
      ).length;
    expect(fresh(more)).toBeGreaterThanOrEqual(fresh(plain));
    expect(more.machine.plan?.diagnostics.newAllowance).toBe(
      (plain.machine.plan?.diagnostics.newAllowance ?? 0) + 5,
    );
  });
});
