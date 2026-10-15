import { describe, expect, it } from "vitest";
import type { SessionState } from "./machine";
import { makeHarness, noteAt, playCorrect, type Harness } from "./test-harness";

/* Try again discards the attempt that was just made; auto-continue moves on after a correct one. */

async function until(
  h: Harness,
  pred: (s: SessionState) => boolean,
  maxMs = 60_000,
): Promise<void> {
  for (let t = 0; t < maxMs && !pred(h.machine.state); t += 50) await h.advance(50);
  if (!pred(h.machine.state)) {
    throw new Error(`condition not reached, stuck in ${JSON.stringify(h.machine.state)}`);
  }
}

async function toFirstItem(h: Harness): Promise<void> {
  await h.machine.start();
  await until(h, (s) => s.kind === "orient" || s.kind === "intro");
  while (h.machine.state.kind === "orient" || h.machine.state.kind === "intro") {
    h.machine.next();
    await h.advance(50);
  }
  await until(h, (s) => s.kind === "listening");
}

/** Answer the current item: right, or one wrong note then Done. */
async function answer(h: Harness, right: boolean): Promise<void> {
  const expected = h.machine.debug().expected;
  if (expected?.play?.kind !== "pitchClass") throw new Error("expected a played degree");
  if (right) playCorrect(h.input, expected, h.clock.ctxMs + 200);
  else h.input.emitNote(noteAt(expected.play.targetMidi + 1, h.clock.ctxMs + 200, "mic"));
  await h.advance(100);
  if (!right) h.machine.answerDone();
  await until(h, (s) => s.kind === "feedback");
}

const types = async (h: Harness): Promise<string[]> => (await h.log()).map((e) => e.type);

describe("Try again", () => {
  it("discards the attempt and asks the same item again, writing nothing for the first go", async () => {
    const h = await makeHarness({ budgetSec: 90 });
    await toFirstItem(h);
    const itemId = (await h.log()).find((e) => e.type === "item.presented");
    await answer(h, false);
    const fb = h.machine.state;
    if (fb.kind !== "feedback") throw new Error("expected feedback");
    expect(fb.feedback.correct).toBe(false);
    expect(fb.canRetry).toBe(true);

    const plays = h.player.plays.length;
    h.machine.retry();
    expect(h.machine.state.kind).toBe("presenting");
    expect(h.player.plays).toHaveLength(plays + 1);
    await until(h, (s) => s.kind === "listening");
    await answer(h, true);
    expect(h.machine.state).toMatchObject({ kind: "feedback", feedback: { correct: true } });

    const log = await h.log();
    const attempts = log.filter((e) => e.type === "attempt.completed");
    // One attempt for the item, and it is the second go; the item was presented once.
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ outcome: { correct: true } });
    expect(log.filter((e) => e.type === "item.presented")).toHaveLength(1);
    expect(itemId).toBeDefined();
  });

  it("is no longer offered once the attempt has been written", async () => {
    const h = await makeHarness({ budgetSec: 90 });
    await toFirstItem(h);
    await answer(h, false);
    h.machine.commit();
    await h.machine.settled();
    h.machine.retry();
    expect(h.machine.state.kind).toBe("feedback");
    expect((await types(h)).filter((t) => t === "attempt.completed")).toHaveLength(1);
  });

  it("counts toward the summary only once", async () => {
    const h = await makeHarness({ budgetSec: 90 });
    await toFirstItem(h);
    await answer(h, false);
    h.machine.retry();
    await until(h, (s) => s.kind === "listening");
    await answer(h, true);
    h.machine.finish();
    await h.machine.settled();
    const s = h.machine.state;
    if (s.kind !== "summary") throw new Error("expected summary");
    expect(s.summary).toMatchObject({ items: 1, correct: 1, accuracy: 1 });
    expect((await types(h)).filter((t) => t === "attempt.completed")).toHaveLength(1);
  });

  it("writes the held-back attempt when the session ends from feedback", async () => {
    const h = await makeHarness({ budgetSec: 90 });
    await toFirstItem(h);
    await answer(h, true);
    h.machine.finish();
    await h.machine.settled();
    expect((await types(h)).filter((t) => t === "attempt.completed")).toHaveLength(1);
  });
});

describe("auto-continue", () => {
  it("moves on after the delay when the answer was right", async () => {
    const h = await makeHarness({ budgetSec: 90, autoContinueMs: 3000 });
    await toFirstItem(h);
    await answer(h, true);
    const fb = h.machine.state;
    if (fb.kind !== "feedback") throw new Error("expected feedback");
    expect(fb.autoContinueMs).toBe(3000);
    expect(fb.feedback.autoAdvance).toBe(false);
    await h.advance(2900);
    expect(h.machine.state.kind).toBe("feedback");
    await h.advance(200);
    expect(h.machine.state.kind).not.toBe("feedback");
  });

  it("waits for Next after a wrong answer", async () => {
    const h = await makeHarness({ budgetSec: 90, autoContinueMs: 3000 });
    await toFirstItem(h);
    await answer(h, false);
    await h.advance(20_000);
    const fb = h.machine.state;
    if (fb.kind !== "feedback") throw new Error("expected feedback");
    expect(fb.autoContinueMs).toBeUndefined();
  });

  it("is off at 0: every answer waits for Next, faded or not", async () => {
    const h = await makeHarness({ budgetSec: 90, autoContinueMs: 0 });
    await toFirstItem(h);
    await answer(h, true);
    await h.advance(20_000);
    expect(h.machine.state).toMatchObject({ kind: "feedback", feedback: { autoAdvance: false } });
  });

  it("Try again and Replay stop the countdown", async () => {
    const h = await makeHarness({ budgetSec: 90, autoContinueMs: 3000 });
    await toFirstItem(h);
    await answer(h, true);
    h.machine.replay();
    await h.advance(10_000);
    expect(h.machine.state.kind).toBe("feedback");
  });
});

describe("played source", () => {
  it("grades an answer made only on the on-screen keys as tapped, and a mic answer as mic", async () => {
    for (const source of ["tap", "mic"] as const) {
      const h = await makeHarness({ budgetSec: 90 });
      await toFirstItem(h);
      const expected = h.machine.debug().expected;
      if (expected?.play?.kind !== "pitchClass") throw new Error("expected a played degree");
      h.input.emitNote(noteAt(expected.play.targetMidi, h.clock.ctxMs + 200, source));
      await until(h, (s) => s.kind === "feedback");
      const attempt = (await h.log()).find((e) => e.type === "attempt.completed");
      expect(attempt).toMatchObject({ inputSource: source, outcome: { correct: true } });
    }
  });
});
