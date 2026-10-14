import { describe, expect, it } from "vitest";
import type { SessionState } from "./machine";
import { targetOnly } from "./machine";
import { makeHarness, noteAt, playCorrect, singCorrect, type Harness } from "./test-harness";

/* The practice step before degree answers, and hearing an item again while listening. */

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

/** Start a session and get to the first item's first listening state. */
async function toFirstItem(h: Harness): Promise<void> {
  await h.machine.start();
  await until(h, (s) => s.kind === "orient" || s.kind === "intro" || s.kind === "presenting");
  while (h.machine.state.kind === "orient" || h.machine.state.kind === "intro") {
    h.machine.next();
    await h.advance(50);
  }
  await until(h, (s) => s.kind === "listening");
}

describe("practice step", () => {
  it("does not score notes until Ready, then scores a fresh answer", async () => {
    const h = await makeHarness({ budgetSec: 90, practiceStep: true });
    await toFirstItem(h);
    const s = h.machine.state;
    if (s.kind !== "listening") throw new Error("not listening");
    expect(s.practice).toBe(true);
    expect(h.machine.debug().phase).toBe("listening-practice");

    // A first (wrong) press does not finish the item, and neither does the right one.
    const expected = h.machine.debug().expected;
    if (expected?.play?.kind !== "pitchClass") throw new Error("expected a played degree");
    h.input.emitNote(noteAt(expected.play.targetMidi + 1, h.clock.ctxMs + 100, h.input.source));
    await h.advance(100);
    playCorrect(h.input, expected, h.clock.ctxMs + 100);
    await h.advance(2000);
    expect(h.machine.state.kind).toBe("listening");

    // The response window has not started, so waiting does not time the item out.
    await h.advance(20_000);
    expect(h.machine.state).toMatchObject({ kind: "listening", practice: true });

    h.machine.answerDone();
    expect(h.machine.state).toMatchObject({ kind: "listening", practice: true });

    h.machine.ready();
    expect(h.machine.state).toMatchObject({ kind: "listening", practice: false });
    // The answer now counts, phase by phase.
    const phases = ["sing", "play"] as const;
    for (const phase of phases) {
      if (h.machine.state.kind !== "listening") break;
      await h.advance(400);
      if (phase === "sing") singCorrect(h.input, expected, h.clock.ctxMs + 100);
      else playCorrect(h.input, expected, h.clock.ctxMs + 100);
      await until(h, (x) => !(x.kind === "listening" && x.phase === phase));
    }
    expect(h.machine.state).toMatchObject({ kind: "feedback", feedback: { correct: true } });
  });

  it("is off by default and in placement", async () => {
    const h = await makeHarness({ budgetSec: 90 });
    await toFirstItem(h);
    expect(h.machine.state).toMatchObject({ kind: "listening", practice: false });
    const p = await makeHarness({ placement: true, practiceStep: true });
    await p.machine.start();
    await until(p, (s) => s.kind === "listening");
    expect(p.machine.state).toMatchObject({ kind: "listening", practice: false });
  });
});

describe("hear again", () => {
  it("replays the cadence and note, or the note alone", async () => {
    const h = await makeHarness({ budgetSec: 90, practiceStep: true });
    await toFirstItem(h);
    const s = h.machine.state;
    if (s.kind !== "listening") throw new Error("not listening");
    expect(s.canHear).toBe(true);
    expect(s.canHearNote).toBe(true);
    const before = h.player.plays.length;
    const full = h.player.plays[before - 1]?.spec;

    h.machine.hear("full");
    expect(h.machine.state.kind).toBe("presenting");
    expect(h.player.plays).toHaveLength(before + 1);
    expect(h.player.plays[before]?.spec).toEqual(full);
    await until(h, (x) => x.kind === "listening");
    expect(h.machine.state).toMatchObject({ kind: "listening", practice: true });

    h.machine.hear("note");
    const note = h.player.plays[before + 1]?.spec;
    expect(note?.events.every((e) => e.role === "target")).toBe(true);
    expect(note?.events[0]?.atSec).toBe(0);
    await until(h, (x) => x.kind === "listening");
    expect(h.machine.state).toMatchObject({ kind: "listening", practice: true });
  });

  it("targetOnly keeps the whole stimulus when there is no target", () => {
    const spec = { events: [{ atSec: 0, midi: [60], durationSec: 1, velocity: 1 }], tempoBpm: 90 };
    expect(targetOnly(spec)).toBe(spec);
  });
});
