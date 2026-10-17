import {
  composeSession,
  type ChordLineTarget,
  type ComposeInput,
  type LearningEvent,
} from "@clavis/core";
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

/* Left-hand chords (T5.3): a progression shown on the bass staff, played as block chords on a MIDI
   keyboard and graded by alignment. Real graph, composer, generator and scorer; only the notation
   port is a fake and the MIDI keyboard is the harness's fake adapter with source "midi". */

const NODE = "hands.lh.triads.root";
const id = (n: number): string => `01JBX0000000000000000${String(n).padStart(5, "0")}`;

/** A learner who met the chord skill three days ago, so it is learning and offers new items. */
function handsHistory(): LearningEvent[] {
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
  /** The chord line of the item last played with `play`, read before its answer ended it. */
  last?: ChordLineTarget;
  h: Harness;
  machine: SessionMachine;
  notation: FakeNotation;
}

async function makeRig(opts: { polyphonic?: boolean } = {}): Promise<Rig> {
  const h = await makeHarness({ budgetSec: 600, inputSource: "midi", history: handsHistory() });
  const notation = new FakeNotation(h.clock);
  const compose = (input: ComposeInput) => {
    const plan = composeSession({ ...input, polyphonic: opts.polyphonic ?? true });
    return {
      ...plan,
      orient: null,
      introductions: [],
      blocks: { ear: [], read: [], apply: plan.blocks.apply },
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

type Tweak = (
  midi: number,
  chord: number,
  tone: number,
  onsetMs: number,
) => { midi: number; onsetMs: number } | undefined;

/** Play the current progression, with `tweak` to change or drop a note. Returns the start time. */
async function play(r: Rig, tweak?: Tweak, wait = feedback): Promise<void> {
  await until(r, listening);
  const expected = r.machine.debug().expected;
  const target = expected?.play;
  if (target?.kind !== "chordLine") throw new Error("not a chord line item");
  r.last = target;
  const start = (r.machine.debug().stimulusEndMs ?? 0) + 700;
  if (tweak === undefined) {
    playCorrect(r.h.input, expected ?? { responseWindowMs: 1 }, start);
  } else {
    const beatMs = 60000 / target.tempoBpm;
    target.chords.forEach((c, ci) => {
      c.midi.forEach((m, ti) => {
        const out = tweak(m, ci, ti, start + c.onsetBeats * beatMs);
        if (out !== undefined) r.h.input.emitNote(noteAt(out.midi, out.onsetMs, "midi"));
      });
    });
  }
  await until(r, wait);
}

function ofType<T extends LearningEvent["type"]>(
  events: LearningEvent[],
  type: T,
): Extract<LearningEvent, { type: T }>[] {
  return events.filter((e): e is Extract<LearningEvent, { type: T }> => e.type === type);
}

const feedbackOf = (r: Rig) => {
  const s = r.machine.state;
  if (s.kind !== "feedback") throw new Error("not feedback");
  return s;
};

describe("a left-hand chord item", () => {
  it("shows the chords on the bass staff with their labels, and starts after a count-in", async () => {
    const r = await makeRig();
    await r.machine.start();
    const s = await until(r, listening);
    if (s.kind !== "listening") throw new Error("not listening");
    expect(s.item).toMatchObject({ block: "apply", generator: "lhPattern", nodeId: NODE });
    expect(s.prompt).toBe("Play these chords with your left hand");
    expect(s.item.display?.staves[0]?.clef).toBe("bass");
    expect(s.item.chords).toHaveLength(4);
    expect(s.item.chords?.[0]?.roman).toBe("I");
    const tonic = r.machine.debug().expected?.play;
    expect(tonic?.kind === "chordLine" && tonic.chords[0]?.symbol).toBe(s.item.chords?.[0]?.symbol);
    expect(r.notation.shows).toHaveLength(1);
    expect(r.h.player.plays).toHaveLength(1);
    expect(r.h.player.plays[0]?.spec.events.every((e) => e.role === "count-in")).toBe(true);
    expect(s.item.inputRange?.low).toBeLessThan(40);
    expect(r.machine.debug().expected?.play?.kind).toBe("chordLine");
  });

  it("offers none of it without a polyphonic input", async () => {
    const r = await makeRig({ polyphonic: false });
    await r.machine.start();
    await r.machine.settled();
    expect(["summary", "nothing"]).toContain(r.machine.state.kind);
    expect(ofType(await logOf(r), "item.presented")).toEqual([]);
  });

  it("grades a MIDI chord sequence through alignment, and logs it against the HANDS node", async () => {
    const r = await makeRig();
    await r.machine.start();
    const startedAt = r.h.clock.ctxMs;
    await play(r);
    const s = feedbackOf(r);
    expect(s.feedback.correct).toBe(true);
    // Done by itself once every tone was struck and the hand lifted: well before the window.
    expect(r.h.clock.ctxMs - startedAt).toBeLessThan(20_000);
    const log = await logOf(r);
    expect(ofType(log, "item.presented")[0]).toMatchObject({
      block: "apply",
      generator: "lhPattern",
      nodeId: NODE,
      isNew: true,
      presentation: { mode: "major", fam: "A" },
    });
    const attempt = ofType(log, "attempt.completed")[0];
    expect(attempt).toMatchObject({
      nodeId: NODE,
      outcome: { correct: true },
      inputSource: "midi",
    });
    expect(attempt?.subScores?.play).toBeGreaterThan(0.9);
    expect(attempt?.errors).toBeUndefined();
    expect(r.h.service.state.nodes[NODE]?.byFamily?.A).toBe("learning");
    expect(r.notation.marks.at(-1)?.map((m) => m.kind)).toEqual([
      "right",
      "right",
      "right",
      "right",
    ]);
  });

  it("accepts chords that are rolled a little", async () => {
    const r = await makeRig();
    await r.machine.start();
    await play(r, (midi, _c, tone, onsetMs) => ({ midi, onsetMs: onsetMs + tone * 25 }));
    expect(feedbackOf(r).feedback.correct).toBe(true);
  });

  it("reports a wrong chord tone by name and marks that chord", async () => {
    const r = await makeRig();
    await r.machine.start();
    // The root of the second chord, one semitone too low (F becomes E in the IV chord of C).
    await play(r, (midi, chord, tone, onsetMs) => ({
      midi: chord === 1 && tone === 0 ? midi - 1 : midi,
      onsetMs,
    }));
    const s = feedbackOf(r);
    expect(s.feedback.correct).toBe(false);
    const second = r.last?.chords[1];
    const rootName = second?.symbol.replace(/m$/, "") ?? "?";
    expect(s.feedback.lines[0]).toMatch(
      new RegExp(
        `^You played [A-G][#b]? instead of ${rootName} in the ${second?.roman ?? "?"} chord\\.$`,
      ),
    );
    const attempt = ofType(await logOf(r), "attempt.completed")[0];
    expect(attempt?.outcome.correct).toBe(false);
    expect(attempt?.errors?.[0]).toMatchObject({
      code: "chord.wrong-tone",
      detail: { index: 1, part: "play" },
    });
    expect(r.notation.marks.at(-1)?.map((m) => m.kind)).toEqual([
      "target",
      "wrong",
      "target",
      "target",
    ]);
    expect(s.feedback.answer).toMatch(/^The chords were I \([A-G][#b]?\), IV \([A-G][#b]?m?\)/);
  });

  it("reports a missed chord after a long pause", async () => {
    const r = await makeRig();
    await r.machine.start();
    await play(r, (midi, chord, _t, onsetMs) => (chord === 2 ? undefined : { midi, onsetMs }));
    const s = feedbackOf(r);
    expect(s.feedback.correct).toBe(false);
    expect(s.feedback.lines[0]).toMatch(/was missed$/);
    const attempt = ofType(await logOf(r), "attempt.completed")[0];
    expect(attempt?.errors?.[0]).toMatchObject({ code: "chord.missed", detail: { index: 2 } });
    expect(r.notation.marks.at(-1)?.map((m) => m.kind)).toEqual([
      "target",
      "target",
      "wrong",
      "target",
    ]);
  });

  it("times out with nothing played", async () => {
    const r = await makeRig();
    await r.machine.start();
    await until(r, listening);
    await until(r, feedback);
    const s = feedbackOf(r);
    expect(s.feedback.correct).toBe(false);
    const attempt = ofType(await logOf(r), "attempt.completed")[0];
    expect(attempt?.errors?.[0]).toMatchObject({ code: "response.timeout" });
  });
});
