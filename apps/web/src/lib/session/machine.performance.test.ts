import {
  FIXTURE_GRAND_STAFF,
  composeSession,
  type ComposeInput,
  type ItemInstance,
  type LearningEvent,
  type PerformanceTarget,
  type PlannedItem,
  type StimulusSpec,
} from "@clavis/core";
import { expectedFromScore } from "@clavis/scoring";
import { describe, expect, it } from "vitest";
import { CHORD_GIVE_UP_MS } from "./completion";
import { SessionMachine, promptFor, type SessionState } from "./machine";
import { FakeNotation, logOf, makeHarness, noteAt, type Harness } from "./test-harness";

/* The grand-staff performance target (T5.4, R27) in the session machine. No generator makes these
   items yet (T5.5 does), so a stub item shows core's grand-staff fixture and expects every note of
   it; the scorer, the completion checks and the feedback are the real ones, on a fake MIDI input. */

const NODE = "read.bass.landmarks";

const COUNT_IN: StimulusSpec = {
  tempoBpm: 60,
  events: [0, 1, 2, 3].map((atSec) => ({
    atSec,
    midi: [76],
    durationSec: 0.1,
    velocity: 0.8,
    role: "count-in" as const,
  })),
};

const TARGET: PerformanceTarget = {
  kind: "performance",
  notes: expectedFromScore(FIXTURE_GRAND_STAFF).map((n) => {
    if (n.hand === undefined) throw new Error("grand staff notes have a hand");
    return { ...n, hand: n.hand };
  }),
  tempoBpm: 60,
  beatsPerBar: 4,
};

function instance(planned: PlannedItem): ItemInstance {
  return {
    itemId: planned.itemId,
    nodeId: planned.nodeId,
    generator: planned.generator,
    params: planned.params,
    presentation: { tonic: "G", mode: "major", tonicMidi: 55, seed: 7 },
    stimulus: COUNT_IN,
    expected: { play: TARGET, responseWindowMs: 20_000 },
    display: FIXTURE_GRAND_STAFF,
    inputRange: { low: 36, high: 84 },
  };
}

interface Rig {
  h: Harness;
  machine: SessionMachine;
  notation: FakeNotation;
}

async function makeRig(): Promise<Rig> {
  const h = await makeHarness({ budgetSec: 600, inputSource: "midi" });
  const notation = new FakeNotation(h.clock);
  const planned: PlannedItem = {
    itemId: `${NODE}|stub`,
    nodeId: NODE,
    generator: "bassNoteRead",
    params: {},
    isNew: false,
    estimatedSec: 20,
  };
  const compose = (input: ComposeInput) => {
    const plan = composeSession(input);
    return {
      ...plan,
      orient: null,
      introductions: [],
      blocks: { ...plan.blocks, ear: [], read: [planned], apply: null },
    };
  };
  const machine = new SessionMachine({
    ...h.deps,
    compose,
    generate: (item) => instance(item),
    notation,
  });
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
  n: PerformanceTarget["notes"][number],
  onsetMs: number,
) => { midi: number; onsetMs: number } | undefined;

/** Play the fixture with both hands, with `tweak` to change or drop a note. Returns the last onset. */
async function play(r: Rig, tweak?: Tweak): Promise<number> {
  await until(r, listening);
  const start = (r.machine.debug().stimulusEndMs ?? 0) + 700;
  const beatMs = 60000 / TARGET.tempoBpm;
  let last = start;
  for (const n of TARGET.notes) {
    const at = start + n.onsetBeats * beatMs;
    const out = tweak === undefined ? { midi: n.midi, onsetMs: at } : tweak(n, at);
    if (out === undefined) continue;
    last = Math.max(last, out.onsetMs);
    r.h.input.emitNote(noteAt(out.midi, out.onsetMs, "midi"));
  }
  return last;
}

function attemptOf(log: LearningEvent[]) {
  const a = log.find((e) => e.type === "attempt.completed");
  if (a?.type !== "attempt.completed") throw new Error("no attempt");
  return a;
}

const feedbackOf = (r: Rig) => {
  const s = r.machine.state;
  if (s.kind !== "feedback") throw new Error("not feedback");
  return s;
};

describe("a grand-staff performance item", () => {
  it("asks for both hands", () => {
    const expected = { play: TARGET, responseWindowMs: 20_000 };
    expect(promptFor("play", ["play"], expected, "instrument", true)).toBe(
      "Play this with both hands",
    );
    const rhOnly = { ...TARGET, notes: TARGET.notes.filter((n) => n.hand === "rh") };
    expect(promptFor("play", ["play"], { ...expected, play: rhOnly }, "instrument", true)).toBe(
      "Play this phrase",
    );
  });

  it("ends the phase once every note is struck and the hands are still, and grades it", async () => {
    const r = await makeRig();
    await r.machine.start();
    const last = await play(r);
    await until(r, feedback);
    // Done by the quiet rule: well before the response window, not before 0.8 s of stillness.
    expect(r.h.clock.ctxMs - last).toBeGreaterThanOrEqual(800);
    expect(r.h.clock.ctxMs - last).toBeLessThan(2000);
    expect(feedbackOf(r).feedback.correct).toBe(true);
    const attempt = attemptOf(await logOf(r));
    expect(attempt).toMatchObject({
      nodeId: NODE,
      outcome: { correct: true },
      inputSource: "midi",
    });
    expect(r.notation.shows[0]?.staves).toHaveLength(2);
    expect(r.notation.marks.at(-1)?.every((m) => m.kind === "right")).toBe(true);
  });

  it("names the bar and hand of a wrong note and marks it on the staff", async () => {
    const r = await makeRig();
    await r.machine.start();
    // n7 is the left hand's D3 on beat 1 of bar 2; C3 is played instead.
    await play(r, (n, at) => ({ midi: n.id === "n7" ? 48 : n.midi, onsetMs: at }));
    await until(r, feedback);
    const s = feedbackOf(r);
    expect(s.feedback.correct).toBe(false);
    expect(s.feedback.lines[0]).toBe("Bar 2: LH played C3 instead of D3");
    expect(attemptOf(await logOf(r)).errors?.[0]).toMatchObject({
      code: "note.wrong",
      detail: { id: "n7", measure: 2, beat: 1, hand: "lh", part: "play" },
    });
    const marks = r.notation.marks.at(-1) ?? [];
    expect(marks.filter((m) => m.kind === "wrong").map((m) => m.noteId)).toEqual(["n7"]);
  });

  it("names a late hand", async () => {
    const r = await makeRig();
    await r.machine.start();
    // The left hand's chord (n6) comes in 450 ms after the right hand's B4.
    await play(r, (n, at) => ({ midi: n.midi, onsetMs: n.id.startsWith("n6") ? at + 450 : at }));
    await until(r, feedback);
    const s = feedbackOf(r);
    expect(s.feedback.lines).toContain("Bar 1: LH late");
  });

  it("gives up after a long silence with notes still missing", async () => {
    const r = await makeRig();
    await r.machine.start();
    // Only bar 1 is played.
    const last = await play(r, (n, at) =>
      n.onsetBeats < 4 ? { midi: n.midi, onsetMs: at } : undefined,
    );
    await until(r, feedback);
    expect(r.h.clock.ctxMs - last).toBeGreaterThanOrEqual(CHORD_GIVE_UP_MS);
    expect(r.h.clock.ctxMs - last).toBeLessThan(CHORD_GIVE_UP_MS + 1000);
    const s = feedbackOf(r);
    expect(s.feedback.correct).toBe(false);
    expect(s.feedback.lines[0]).toMatch(/^Bar 2: (RH|LH) missed [A-G]/);
  });
});
