import { getGenerator, type LearnerState, type PlannedItem, type ScoreSpec } from "@clavis/core";
import { describe, expect, it } from "vitest";
import type { NotationPort } from "../notation/port";
import type { SessionState } from "./machine";
import { makeHarness, noteAt, playCorrect, type Harness } from "./test-harness";

/* The guide keyboard, the staff beside the rhythm, and the early-stage gating of both. */

const DEGREES = "ear.degrees.major.135";

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

/** Pretend every node is at `state`, as if the learner had got further. */
function atStage(h: Harness, nodeId: string, state: "learning" | "fluent"): void {
  h.deps.getState = (): LearnerState => {
    const s = h.service.state;
    return { ...s, nodes: { ...s.nodes, [nodeId]: { ...s.nodes[nodeId], state } } };
  };
}

describe("guide keyboard", () => {
  it("marks the home note and chord in the question, then the answer and what was played", async () => {
    const h = await makeHarness({ budgetSec: 90 });
    await toFirstItem(h);
    const s = h.machine.state;
    if (s.kind !== "listening") throw new Error("not listening");
    expect(s.item.guide).toMatchObject({ tonicPc: 0, chordPcs: [0, 4, 7] });

    const expected = h.machine.debug().expected;
    if (expected?.play?.kind !== "pitchClass") throw new Error("expected a played degree");
    const target = expected.play.targetMidi;
    h.input.emitNote(noteAt(target + 1, h.clock.ctxMs + 200, "mic"));
    await h.advance(100);
    playCorrect(h.input, expected, h.clock.ctxMs + 200);
    await until(h, (x) => x.kind === "feedback");
    const fb = h.machine.state;
    if (fb.kind !== "feedback") throw new Error("expected feedback");
    expect(fb.answerKeys?.targetPcs).toEqual([target % 12]);
    expect(fb.answerKeys?.played).toEqual([target + 1, target]);
  });

  it("is absent once the skill is fluent", async () => {
    const h = await makeHarness({ budgetSec: 90 });
    atStage(h, DEGREES, "fluent");
    await toFirstItem(h);
    const s = h.machine.state;
    if (s.kind !== "listening") throw new Error("not listening");
    expect(s.item.guide).toBeUndefined();
    expect(s.item.keyNotes).toBeUndefined();
  });
});

describe("practice step", () => {
  it("is skipped once the skill is fluent", async () => {
    const h = await makeHarness({ budgetSec: 90, practiceStep: true });
    atStage(h, DEGREES, "fluent");
    await toFirstItem(h);
    expect(h.machine.state).toMatchObject({ kind: "listening", practice: false });
  });
});

describe("hearing again", () => {
  it("mid-answer restarts the window and drops notes already played", async () => {
    const h = await makeHarness({ budgetSec: 90 });
    await toFirstItem(h);
    const expected = h.machine.debug().expected;
    if (expected?.play?.kind !== "pitchClass") throw new Error("expected a played degree");
    h.input.emitNote(noteAt(expected.play.targetMidi + 1, h.clock.ctxMs + 100, "mic"));
    await h.advance(200);
    h.machine.hear("full");
    expect(h.machine.state.kind).toBe("presenting");
    await until(h, (s) => s.kind === "listening");
    playCorrect(h.input, expected, h.clock.ctxMs + 200);
    await until(h, (s) => s.kind === "feedback");
    const fb = h.machine.state;
    if (fb.kind !== "feedback") throw new Error("expected feedback");
    // The earlier wrong note was discarded, so the answer counts as a first-try hit.
    expect(fb.feedback.correct).toBe(true);
    expect(fb.answerKeys?.played).toEqual([expected.play.targetMidi]);
  });
});

function fakeNotation(): NotationPort & { shows: ScoreSpec[]; preloads: () => number } {
  const shows: ScoreSpec[] = [];
  let preloads = 0;
  return {
    shows,
    preloads: () => preloads,
    preload: () => {
      preloads++;
      return Promise.resolve();
    },
    show: (score) => {
      shows.push(score);
      return Promise.resolve();
    },
    highlight: () => undefined,
    hide: () => undefined,
  };
}

/** Turn the plan's ear items into rhythm echo items on the rhythm node. */
function rhythmOnly(h: Harness): void {
  const compose = h.deps.compose.bind(h.deps);
  h.deps.compose = (input) => {
    const plan = compose(input);
    const asRhythm = (p: PlannedItem): PlannedItem => ({
      ...p,
      nodeId: "ear.rhythm.echo",
      generator: "rhythmEcho",
      params: { pattern: "r06" },
    });
    return { ...plan, blocks: { ...plan.blocks, ear: plan.blocks.ear.map(asRhythm) } };
  };
  h.deps.generate = (item, ctx) => {
    const node = h.graph.nodes.find((n) => n.id === item.nodeId);
    if (!node) throw new Error(item.nodeId);
    return getGenerator(item.generator).generate(node, item.params, ctx);
  };
}

describe("staff beside the rhythm", () => {
  it("is drawn while the rhythm plays in the early stages, once notation has loaded", async () => {
    const notation = fakeNotation();
    const h = await makeHarness({ budgetSec: 90, notation });
    rhythmOnly(h);
    await h.machine.start();
    await until(h, (s) => s.kind === "orient" || s.kind === "intro" || s.kind === "presenting");
    while (h.machine.state.kind === "orient" || h.machine.state.kind === "intro") {
      h.machine.next();
      await h.advance(50);
    }
    await until(h, (s) => s.kind === "listening");
    expect(notation.preloads()).toBeGreaterThan(0);
    expect(notation.shows).toHaveLength(1);
    const s = h.machine.state;
    if (s.kind !== "listening") throw new Error("not listening");
    expect(s.item.showStaff).toBe(true);
    // The audio is still the question: the whole stimulus played.
    expect(h.player.plays.at(-1)?.spec.events.some((e) => e.role === "target")).toBe(true);
  });

  it("fades out when the skill is fluent, and without notation", async () => {
    const notation = fakeNotation();
    const h = await makeHarness({ budgetSec: 90, notation });
    rhythmOnly(h);
    atStage(h, "ear.rhythm.echo", "fluent");
    await toFirstItem(h);
    expect(notation.shows).toHaveLength(0);

    const bare = await makeHarness({ budgetSec: 90 });
    rhythmOnly(bare);
    await toFirstItem(bare);
    const s = bare.machine.state;
    if (s.kind !== "listening") throw new Error("not listening");
    expect(s.item.showStaff).toBeUndefined();
  });
});
