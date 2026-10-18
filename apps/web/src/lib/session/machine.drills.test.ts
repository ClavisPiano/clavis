import {
  composeSession,
  type ComposeInput,
  type LearningEvent,
  type PlannedItem,
} from "@clavis/core";
import { describe, expect, it } from "vitest";
import { SessionMachine, type SessionState } from "./machine";
import { FakeNotation, logOf, makeHarness, noteAt, T0, type Harness } from "./test-harness";

/* Micro-drills (T5.8, R27): a failed left-hand chord item spawns one drill for its first erring
   chord change, written with the attempt as `drill.spawned`. Real graph, composer, generator,
   scorer and reducer; the notation port is a fake and the keyboard is the harness's fake MIDI. */

const NODE = "hands.lh.triads.root";
const PROG = ["I", "IV", "V", "I"];
const SOURCE = `${NODE}|fam=A|prog=I-IV-V-I`;
const DRILL = `${NODE}|drill=IV-V|fam=A`;
const id = (n: number): string => `01JBX0000000000000000${String(n).padStart(5, "0")}`;

/** A learner who met the chord skill three days ago, so it is learning. */
function history(): LearningEvent[] {
  const at = T0 - 3 * 86_400_000;
  const base = { deviceId: "seed-device", v: 1 };
  return [
    {
      ...base,
      id: id(1),
      at,
      type: "session.started",
      sessionId: id(2),
      mode: "instrument",
      budgetSec: 720,
      key: { tonic: "C", mode: "major" },
      tzOffsetMin: 0,
      contentVersion: "seed",
    },
    {
      ...base,
      id: id(3),
      at: at + 1000,
      type: "node.introduced",
      sessionId: id(2),
      nodeId: NODE,
      keyFamily: "A",
    },
    {
      ...base,
      id: id(4),
      at: at + 60_000,
      type: "session.ended",
      sessionId: id(2),
      reason: "completed",
    },
  ] as unknown as LearningEvent[];
}

interface Rig {
  h: Harness;
  machine: SessionMachine;
}

/** A session whose Apply block is the one item I-IV-V-I in C. */
async function makeRig(): Promise<Rig> {
  const h = await makeHarness({ budgetSec: 600, inputSource: "midi", history: history() });
  const compose = (input: ComposeInput) => {
    const plan = composeSession({ ...input, polyphonic: true });
    const first = plan.blocks.apply?.find((i) => i.nodeId === NODE);
    if (!first) throw new Error("no chord item planned");
    const item: PlannedItem = {
      ...first,
      itemId: SOURCE,
      params: { fam: "A", prog: PROG },
      key: { tonic: "C", mode: "major" },
    };
    return {
      ...plan,
      orient: null,
      introductions: [],
      blocks: { ear: [], read: [], apply: [item] },
    };
  };
  const machine = new SessionMachine({ ...h.deps, compose, notation: new FakeNotation(h.clock) });
  return { h, machine };
}

async function until(r: Rig, pred: (s: SessionState) => boolean, maxMs = 60_000): Promise<void> {
  for (let t = 0; t < maxMs && !pred(r.machine.state); t += 50) await r.h.advance(50);
  if (!pred(r.machine.state)) {
    throw new Error(`condition not reached, stuck in ${JSON.stringify(r.machine.state)}`);
  }
}

/** Play the progression with the root of chord `wrongChord` a semitone low (none: all right). */
async function play(r: Rig, wrongChord?: number): Promise<void> {
  await until(r, (s) => s.kind === "listening");
  const target = r.machine.debug().expected?.play;
  if (target?.kind !== "chordLine") throw new Error("not a chord line item");
  expect(target.chords.map((c) => c.roman)).toEqual(PROG);
  const start = (r.machine.debug().stimulusEndMs ?? 0) + 700;
  const beatMs = 60_000 / target.tempoBpm;
  target.chords.forEach((c, ci) => {
    c.midi.forEach((m, ti) => {
      const midi = ci === wrongChord && ti === 0 ? m - 1 : m;
      r.h.input.emitNote(noteAt(midi, start + c.onsetBeats * beatMs, "midi"));
    });
  });
  await until(r, (s) => s.kind === "feedback");
}

const ofType = <T extends LearningEvent["type"]>(events: LearningEvent[], type: T) =>
  events.filter((e): e is Extract<LearningEvent, { type: T }> => e.type === type);

describe("micro-drills from a session", () => {
  it("spawns exactly one drill for a failed IV to V change, due at once", async () => {
    const r = await makeRig();
    await r.machine.start();
    await play(r, 2);
    const s = r.machine.state;
    expect(s.kind === "feedback" && s.feedback.correct).toBe(false);

    const log = await logOf(r);
    const attempt = ofType(log, "attempt.completed")[0];
    expect(attempt?.errors?.[0]).toMatchObject({ code: "chord.wrong-tone", detail: { index: 2 } });
    const drills = ofType(log, "drill.spawned");
    expect(drills).toHaveLength(1);
    expect(drills[0]).toMatchObject({
      v: 1,
      sessionId: attempt?.sessionId,
      sourceItemId: SOURCE,
      nodeId: NODE,
      itemIds: [DRILL],
    });

    const state = r.h.service.state;
    expect(state.drills[NODE]).toEqual([DRILL]);
    const card = state.cards[DRILL];
    expect(card?.nodeId).toBe(NODE);
    expect(card?.reps).toBe(0);
    expect(card?.card.due).toBeLessThanOrEqual(r.h.clock.wallNow());

    // The next session plans the drill first.
    const next = composeSession({
      state,
      graph: r.h.deps.graph,
      now: r.h.clock.wallNow() + 60_000,
      tzOffsetMin: 0,
      seed: 7,
      mode: "instrument",
      polyphonic: true,
    });
    expect(next.blocks.apply?.[0]).toMatchObject({
      itemId: DRILL,
      nodeId: NODE,
      generator: "lhPattern",
      params: { fam: "A", drill: "IV-V" },
      isNew: false,
    });
  });

  it("spawns nothing for a correct attempt", async () => {
    const r = await makeRig();
    await r.machine.start();
    await play(r);
    const log = await logOf(r);
    expect(ofType(log, "attempt.completed")[0]?.outcome.correct).toBe(true);
    expect(ofType(log, "drill.spawned")).toEqual([]);
    expect(r.h.service.state.drills).toEqual({});
  });

  it("drops the drill with the attempt on Try again", async () => {
    const r = await makeRig();
    await r.machine.start();
    await play(r, 2);
    r.machine.retry();
    await play(r);
    const log = await logOf(r);
    expect(ofType(log, "attempt.completed")).toHaveLength(1);
    expect(ofType(log, "drill.spawned")).toEqual([]);
    expect(r.h.service.state.cards[DRILL]).toBeUndefined();
  });
});
