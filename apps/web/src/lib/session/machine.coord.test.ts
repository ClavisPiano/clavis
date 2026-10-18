import { loadGraph } from "@clavis/content";
import {
  ALL_KEYS,
  composeSession,
  coordTask,
  createRng,
  keyFamily,
  type ComposeInput,
  type LearningEvent,
  type PerformanceTarget,
} from "@clavis/core";
import { expectedFromScore, scoreAttempt } from "@clavis/scoring";
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

/* Hands together over block chords (T5.5): a coordTask item on the grand staff, played with both
   hands on a MIDI keyboard and graded as a performance. Real graph, composer, generator and
   scorer; the notation port is a fake and the keyboard is the harness's fake MIDI adapter. */

const NODE = "hands.coord.basic";
const graph = loadGraph();
const node = graph.nodes.find((n) => n.id === NODE);
if (node === undefined) throw new Error(`no ${NODE} in the graph`);

describe("scoring a coordTask item", () => {
  const items = coordTask.listItems(node);
  const MAJOR = ALL_KEYS.filter((k) => k.mode === "major");

  it("passes a perfect MIDI performance of every item in a key of its family", () => {
    items.forEach((params, i) => {
      const keys = MAJOR.filter((k) => keyFamily(k) === params.fam);
      const key = keys[i % keys.length];
      const inst = coordTask.generate(node, params, {
        rng: createRng(i),
        mode: "instrument",
        ...(key ? { preferredKey: key } : {}),
      });
      const play = inst.expected.play;
      if (play?.kind !== "performance") throw new Error("expected a performance");
      // The target is exactly what the grand staff says, ids and hands included.
      if (!inst.display) throw new Error("no display");
      expect(expectedFromScore(inst.display)).toEqual(play.notes);

      const start = 10_000;
      const beatMs = 60_000 / play.tempoBpm;
      const notes = play.notes.map((n, k) =>
        // Both hands together within a few milliseconds, as a real keyboard reports them.
        noteAt(n.midi, start + n.onsetBeats * beatMs + (k % 3) * 4, "midi"),
      );
      const result = scoreAttempt({
        expected: inst.expected,
        notes,
        stimulusEndMs: start - 600,
        source: "midi",
      });
      expect(result.outcome.correct, inst.itemId).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.subScores.play).toBeGreaterThan(0.95);
    });
  });

  it("fails a performance with a wrong left-hand note and names its bar", () => {
    const inst = coordTask.generate(
      node,
      { fam: "A", prog: ["I", "IV", "V", "I"], mel: 1 },
      { rng: createRng(1), mode: "instrument", preferredKey: { tonic: "G", mode: "major" } },
    );
    const play = inst.expected.play as PerformanceTarget;
    const start = 10_000;
    const notes = play.notes.map((n) =>
      noteAt(n.id === "n19.0" ? n.midi - 1 : n.midi, start + n.onsetBeats * 1000, "midi"),
    );
    const result = scoreAttempt({
      expected: inst.expected,
      notes,
      stimulusEndMs: start - 600,
      source: "midi",
    });
    expect(result.outcome.correct).toBe(false);
    expect(result.errors[0]).toMatchObject({
      code: "note.wrong",
      detail: { id: "n19.0", measure: 3, beat: 1, hand: "lh" },
    });
  });
});

const id = (n: number): string => `01JBX0000000000000000${String(n).padStart(5, "0")}`;

/** A learner who started hands together two days ago, so it is learning and offers new items. */
function coordHistory(): LearningEvent[] {
  const at = T0 - 2 * 86_400_000;
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
    // Left-hand chords placed as mastered, so hands together unlocks.
    {
      ...base,
      id: id(5),
      at: at + 500,
      type: "placement.completed",
      placementId: id(6),
      results: { "hands.lh.triads.root": "mastered" },
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
  notation: FakeNotation;
}

async function makeRig(): Promise<Rig> {
  const h = await makeHarness({ budgetSec: 600, inputSource: "midi", history: coordHistory() });
  const notation = new FakeNotation(h.clock);
  const compose = (input: ComposeInput) => {
    const plan = composeSession({ ...input, polyphonic: true });
    return {
      ...plan,
      orient: null,
      introductions: [],
      blocks: {
        ear: [],
        read: [],
        apply: plan.blocks.apply?.filter((i) => i.nodeId === NODE) ?? null,
      },
    };
  };
  const machine = new SessionMachine({ ...h.deps, compose, notation });
  return { h, machine, notation };
}

async function until(
  r: Rig,
  pred: (s: SessionState) => boolean,
  maxMs = 90_000,
): Promise<SessionState> {
  for (let t = 0; t < maxMs && !pred(r.machine.state); t += 50) await r.h.advance(50);
  if (!pred(r.machine.state)) {
    throw new Error(`condition not reached, stuck in ${JSON.stringify(r.machine.state)}`);
  }
  return r.machine.state;
}

describe("a coordTask item in a session", () => {
  it("shows the grand staff with chord labels and hands, and grades a MIDI performance", async () => {
    const r = await makeRig();
    await r.machine.start();
    const s = await until(r, (st) => st.kind === "listening");
    if (s.kind !== "listening") throw new Error("not listening");
    expect(s.item).toMatchObject({
      block: "apply",
      generator: "coordTask",
      nodeId: NODE,
      bothHands: true,
    });
    expect(s.prompt).toBe("Play this with both hands");
    expect(s.item.display?.staves.map((st) => st.clef)).toEqual(["treble", "bass"]);
    expect(s.item.chords).toHaveLength(4);
    expect(s.item.chords?.[0]?.roman).toBe("I");
    expect(r.h.player.plays[0]?.spec.events.every((e) => e.role === "count-in")).toBe(true);

    const expected = r.machine.debug().expected;
    if (expected?.play?.kind !== "performance") throw new Error("not a performance");
    playCorrect(r.h.input, expected, (r.machine.debug().stimulusEndMs ?? 0) + 700);
    await until(r, (st) => st.kind === "feedback");
    const f = r.machine.state;
    if (f.kind !== "feedback") throw new Error("not feedback");
    expect(f.feedback.correct).toBe(true);
    const log = await logOf(r);
    const attempt = log.find((e) => e.type === "attempt.completed");
    expect(attempt).toMatchObject({
      nodeId: NODE,
      outcome: { correct: true },
      inputSource: "midi",
    });
    expect(r.notation.marks.at(-1)?.every((m) => m.kind === "right")).toBe(true);
  });
});
