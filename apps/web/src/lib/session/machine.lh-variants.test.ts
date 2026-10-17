import { loadGraph } from "@clavis/content";
import {
  ALL_KEYS,
  composeSession,
  createRng,
  GENERATORS,
  type ComposeInput,
  type ItemInstance,
  type LearningEvent,
  type NoteEvent,
} from "@clavis/core";
import { scoreAttempt } from "@clavis/scoring";
import { describe, expect, it } from "vitest";
import { SessionMachine, type SessionState } from "./machine";
import { FakeNotation, logOf, makeHarness, noteAt, playCorrect, T0 } from "./test-harness";

/* Left-hand pattern variants (T5.7): inversions as chord lines, broken and pop patterns as single
   lines, all from a MIDI keyboard. Real graph, generator and scorer. */

const graph = loadGraph();
const generator = GENERATORS.lhPatternVariants;
const NODES = ["hands.lh.inversions", "hands.lh.broken", "hands.lh.pop"] as const;
const nodeOf = (id: string) => {
  const n = graph.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`no node ${id}`);
  return n;
};
const MAJOR = ALL_KEYS.filter((k) => k.mode === "major");

/** A note-perfect MIDI take of `item`, starting `startMs` after the stimulus. */
function perfectTake(item: ItemInstance, startMs: number): NoteEvent[] {
  const play = item.expected.play;
  if (play?.kind === "chordLine") {
    const beatMs = 60000 / play.tempoBpm;
    return play.chords.flatMap((c) =>
      c.midi.map((m) => noteAt(m, startMs + c.onsetBeats * beatMs, "midi")),
    );
  }
  if (play?.kind === "line") {
    const beatMs = 60000 / play.tempoBpm;
    return play.midi.map((m, i) =>
      noteAt(m, startMs + (play.onsetsBeats[i] ?? 0) * beatMs, "midi"),
    );
  }
  throw new Error(`unexpected target ${String(play?.kind)}`);
}

const score = (item: ItemInstance, notes: NoteEvent[]) =>
  scoreAttempt({ expected: item.expected, notes, stimulusEndMs: 0, source: "midi" });

describe("scoring left-hand pattern variants from MIDI", () => {
  it.each(NODES.map((n) => [n] as const))(
    "%s: a perfect take of every item is correct, in every major key",
    (nodeId) => {
      if (!generator) throw new Error("lhPatternVariants is not registered");
      const node = nodeOf(nodeId);
      const items = generator.listItems(node);
      items.forEach((params, i) => {
        const key = MAJOR[i % MAJOR.length];
        const item = generator.generate(node, params, {
          rng: createRng(i),
          voiceRange: { low: 48, high: 72 },
          mode: "instrument",
          ...(key ? { preferredKey: key } : {}),
        });
        const r = score(item, perfectTake(item, 700));
        expect(r.outcome.correct, item.itemId).toBe(true);
        expect(r.errors).toEqual([]);
        expect(r.subScores.play).toBeGreaterThan(0.9);
      });
    },
  );

  it.each(NODES.map((n) => [n] as const))(
    "%s: a wrong note or a missed note is not correct",
    (nodeId) => {
      if (!generator) throw new Error("lhPatternVariants is not registered");
      const node = nodeOf(nodeId);
      const params = generator.listItems(node)[7];
      if (!params) throw new Error("no items");
      const item = generator.generate(node, params, {
        rng: createRng(3),
        voiceRange: { low: 48, high: 72 },
        mode: "instrument",
      });
      const take = perfectTake(item, 700);
      const wrong = take.map((n, i) => (i === 5 ? { ...n, pitch: n.pitch + 1 } : n));
      expect(score(item, wrong).outcome.correct).toBe(false);
      expect(score(item, take.slice(0, -1)).outcome.correct).toBe(false);
    },
  );
});

const id = (n: number): string => `01JBX0000000000000000${String(n).padStart(5, "0")}`;

/** A learner who met `nodeId` three days ago, so it is learning and offers new items. */
function history(nodeId: string): LearningEvent[] {
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
      nodeId,
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

describe.each(NODES.map((n) => [n] as const))("a %s item in a MIDI session", (nodeId) => {
  it("is shown on the bass staff with chord labels, and a perfect take is correct", async () => {
    // Unlocked from the start, so the history can introduce it without mastering its prerequisites.
    const unlocked = {
      ...graph,
      nodes: graph.nodes.map((n) => (n.id === nodeId ? { ...n, prerequisites: [] } : n)),
    };
    const h = await makeHarness({
      budgetSec: 600,
      inputSource: "midi",
      history: history(nodeId),
      graph: unlocked,
    });
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
          apply: (plan.blocks.apply ?? []).filter((i) => i.nodeId === nodeId),
        },
      };
    };
    const machine = new SessionMachine({ ...h.deps, compose, notation });
    const until = async (pred: (s: SessionState) => boolean): Promise<SessionState> => {
      for (let t = 0; t < 60_000 && !pred(machine.state); t += 50) await h.advance(50);
      if (!pred(machine.state)) throw new Error(`stuck in ${JSON.stringify(machine.state)}`);
      return machine.state;
    };
    await machine.start();
    const s = await until((x) => x.kind === "listening");
    if (s.kind !== "listening") throw new Error("not listening");
    expect(s.item).toMatchObject({ block: "apply", generator: "lhPatternVariants", nodeId });
    expect(s.item.display?.staves[0]?.clef).toBe("bass");
    expect(s.item.chords).toHaveLength(4);
    expect(s.prompt).toBe(
      nodeId === "hands.lh.inversions"
        ? "Play these chords with your left hand"
        : "Play this pattern with your left hand",
    );
    const expected = machine.debug().expected;
    playCorrect(
      h.input,
      expected ?? { responseWindowMs: 1 },
      (machine.debug().stimulusEndMs ?? 0) + 700,
    );
    const f = await until((x) => x.kind === "feedback");
    if (f.kind !== "feedback") throw new Error("not feedback");
    expect(f.feedback.correct).toBe(true);
    const attempt = (await logOf({ machine, h })).find((e) => e.type === "attempt.completed");
    expect(attempt).toMatchObject({ nodeId, outcome: { correct: true }, inputSource: "midi" });
  });
});
