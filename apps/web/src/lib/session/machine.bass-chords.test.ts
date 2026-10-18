import { loadGraph } from "@clavis/content";
import {
  composeSession,
  type ChordLineTarget,
  type ComposeInput,
  type LearningEvent,
  type SkillGraph,
} from "@clavis/core";
import { describe, expect, it } from "vitest";
import { SessionMachine, type SessionState } from "./machine";
import { CHORD_GIVE_UP_MS, SEQUENCE_QUIET_MS } from "./completion";
import { FakeNotation, logOf, makeHarness, noteAt, T0, type Harness } from "./test-harness";

/* Bass chord reading (T5.10): one triad shown on the bass staff with no sound and no count-in,
   played as a block chord on a MIDI keyboard and graded on its tones only. Real graph, composer,
   generator and scorer; the notation port is a fake and MIDI is the harness's fake adapter. */

const NODE = "read.bass.chords";
/**
 * The real graph with the node's prerequisites (bass skips and left-hand triads) dropped, so a
 * learner can be put straight onto it by its introduction.
 */
function graph(): SkillGraph {
  const g = loadGraph();
  return {
    ...g,
    nodes: g.nodes.map((n) => (n.id === NODE ? { ...n, prerequisites: [] } : n)),
  };
}

const id = (n: number): string => `01JBX0000000000000000${String(n).padStart(5, "0")}`;

/** A learner who met chord reading three days ago, so it is learning and offers new items. */
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
  notation: FakeNotation;
}

async function makeRig(opts: { polyphonic?: boolean } = {}): Promise<Rig> {
  const h = await makeHarness({
    budgetSec: 600,
    inputSource: "midi",
    history: history(),
    graph: graph(),
  });
  const notation = new FakeNotation(h.clock);
  // Paint takes a moment: the reference time is when the score is on screen, not before.
  notation.showDelayMs = 120;
  const compose = (input: ComposeInput) => {
    const plan = composeSession({ ...input, polyphonic: opts.polyphonic ?? true });
    return {
      ...plan,
      orient: null,
      introductions: [],
      blocks: { ear: [], read: plan.blocks.read.filter((i) => i.nodeId === NODE), apply: null },
    };
  };
  const machine = new SessionMachine({ ...h.deps, compose, notation });
  return { h, machine, notation };
}

async function until(
  r: Rig,
  pred: (s: SessionState) => boolean,
  maxMs = 60_000,
): Promise<SessionState> {
  for (let t = 0; t < maxMs && !pred(r.machine.state); t += 50) await r.h.advance(50);
  if (!pred(r.machine.state)) {
    throw new Error(`condition not reached, stuck in ${JSON.stringify(r.machine.state)}`);
  }
  return r.machine.state;
}

const listening = (s: SessionState): boolean => s.kind === "listening";
const feedback = (s: SessionState): boolean => s.kind === "feedback";

function feedbackOf(r: Rig) {
  const s = r.machine.state;
  if (s.kind !== "feedback") throw new Error("not feedback");
  return s;
}

function ofType<T extends LearningEvent["type"]>(
  events: LearningEvent[],
  type: T,
): Extract<LearningEvent, { type: T }>[] {
  return events.filter((e): e is Extract<LearningEvent, { type: T }> => e.type === type);
}

/** The chord of the current item, once it is listening. */
async function chordOf(r: Rig): Promise<ChordLineTarget> {
  await until(r, listening);
  const play = r.machine.debug().expected?.play;
  if (play?.kind !== "chordLine") throw new Error("not a chord line item");
  return play;
}

/** Play `midi` at `afterMs` from the score being shown, one onset per entry. */
function playAt(r: Rig, notes: { midi: number; afterMs: number }[]): number {
  const shown = r.machine.debug().stimulusEndMs ?? 0;
  for (const n of notes) r.h.input.emitNote(noteAt(n.midi, shown + n.afterMs, "midi"));
  return shown;
}

describe("a bass chord reading item", () => {
  it("shows one chord on the bass staff, with no sound, no count-in and no labels", async () => {
    const r = await makeRig();
    await r.machine.start();
    const s = await until(r, listening);
    if (s.kind !== "listening") throw new Error("not listening");
    expect(s.item).toMatchObject({ block: "read", generator: "bassChordRead", nodeId: NODE });
    expect(s.prompt).toBe("Play this chord with your left hand");
    // Reading the chord is the task, so its numeral and symbol are not shown.
    expect(s.item.chords).toBeUndefined();
    expect(s.item.display?.staves[0]?.clef).toBe("bass");
    expect(r.notation.shows).toHaveLength(1);
    expect(r.h.player.plays).toHaveLength(0);
    const play = await chordOf(r);
    expect(play.chords).toHaveLength(1);
    expect(play.gradeTiming).toBe(false);
    // The reference is the paint time, so latency counts from the score being on screen.
    expect(r.machine.debug().stimulusEndMs).toBeGreaterThanOrEqual(120);
    expect(r.machine.debug().phaseStartMs).toBe(r.machine.debug().stimulusEndMs);
  });

  it("offers none of it without a polyphonic input", async () => {
    const r = await makeRig({ polyphonic: false });
    await r.machine.start();
    await r.machine.settled();
    expect(["summary", "nothing"]).toContain(r.machine.state.kind);
    expect(ofType(await logOf(r), "item.presented")).toEqual([]);
  });

  it("ends a moment after the chord, and logs a correct answer with latency from the score", async () => {
    const r = await makeRig();
    await r.machine.start();
    const play = await chordOf(r);
    const midi = play.chords[0]?.midi ?? [];
    const shown = playAt(
      r,
      midi.map((m) => ({ midi: m, afterMs: 2_500 })),
    );
    await until(r, feedback);
    // Done by itself once the hand was still: well before the 10 s window.
    expect(r.h.clock.ctxMs).toBeLessThan(shown + 2_500 + SEQUENCE_QUIET_MS + 200);
    expect(feedbackOf(r).feedback.correct).toBe(true);
    const log = await logOf(r);
    expect(ofType(log, "item.presented")[0]).toMatchObject({
      block: "read",
      generator: "bassChordRead",
      nodeId: NODE,
      presentation: { mode: "major", fam: "A" },
    });
    const attempt = ofType(log, "attempt.completed")[0];
    expect(attempt).toMatchObject({
      nodeId: NODE,
      outcome: { correct: true },
      inputSource: "midi",
    });
    expect(attempt?.outcome.latencyMs).toBe(2_500);
    expect(attempt?.errors).toBeUndefined();
    expect(r.notation.marks.at(-1)?.map((m) => m.kind)).toEqual(["right"]);
  });

  it("accepts a chord pressed a little unevenly, with no timing complaint", async () => {
    const r = await makeRig();
    await r.machine.start();
    const play = await chordOf(r);
    playAt(
      r,
      (play.chords[0]?.midi ?? []).map((m, i) => ({ midi: m, afterMs: 1_800 + i * 110 })),
    );
    await until(r, feedback);
    expect(feedbackOf(r).feedback.correct).toBe(true);
    const attempt = ofType(await logOf(r), "attempt.completed")[0];
    expect(attempt?.errors).toBeUndefined();
  });

  it("names a wrong tone, marks the chord and says what it was", async () => {
    const r = await makeRig();
    await r.machine.start();
    const play = await chordOf(r);
    const chord = play.chords[0];
    const midi = chord?.midi ?? [];
    playAt(
      r,
      midi.map((m, i) => ({ midi: i === 2 ? m + 1 : m, afterMs: 2_000 })),
    );
    await until(r, feedback);
    const s = feedbackOf(r);
    expect(s.feedback.correct).toBe(false);
    expect(s.feedback.lines[0]).toMatch(
      new RegExp(
        `^You played [A-G][#b]? instead of [A-G][#b]? in the ${chord?.roman ?? "?"} chord\\.$`,
      ),
    );
    const tonic = ofType(await logOf(r), "item.presented")[0]?.presentation.tonic;
    expect(typeof tonic).toBe("string");
    expect(s.feedback.answer).toBe(
      `The chord was ${chord?.roman ?? "?"} (${chord?.symbol ?? "?"}) in ${tonic as string} major.`,
    );
    expect(r.notation.marks.at(-1)?.map((m) => m.kind)).toEqual(["wrong"]);
    const attempt = ofType(await logOf(r), "attempt.completed")[0];
    expect(attempt?.errors?.map((e) => e.code)).toEqual(["chord.wrong-tone"]);
  });

  it("gives up after a long pause with a tone missing", async () => {
    const r = await makeRig();
    await r.machine.start();
    const play = await chordOf(r);
    const shown = playAt(
      r,
      (play.chords[0]?.midi ?? []).slice(0, 2).map((m) => ({ midi: m, afterMs: 1_000 })),
    );
    await until(r, feedback);
    expect(r.h.clock.ctxMs).toBeGreaterThanOrEqual(shown + 1_000 + CHORD_GIVE_UP_MS);
    expect(r.h.clock.ctxMs).toBeLessThan(shown + 1_000 + CHORD_GIVE_UP_MS + 500);
    const attempt = ofType(await logOf(r), "attempt.completed")[0];
    expect(attempt?.outcome.correct).toBe(false);
    expect(attempt?.errors?.map((e) => e.code)).toEqual(["chord.missing-tone"]);
  });

  it("times out at the response window with nothing played", async () => {
    const r = await makeRig();
    await r.machine.start();
    await until(r, listening);
    await until(r, feedback);
    const attempt = ofType(await logOf(r), "attempt.completed")[0];
    expect(attempt?.outcome.correct).toBe(false);
    expect(attempt?.errors?.[0]).toMatchObject({ code: "response.timeout" });
  });
});
