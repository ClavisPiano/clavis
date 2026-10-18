import {
  composeSession,
  type ChordLineTarget,
  type ComposeInput,
  type LearningEvent,
  type NoteEvent,
} from "@clavis/core";
import { describe, expect, it } from "vitest";
import { SessionMachine, type SessionState } from "./machine";
import { FakeNotation, logOf, makeHarness, noteAt, T0, type Harness } from "./test-harness";

/* Chords on the microphone (T8.19, R31): the answer is recorded, transcribed after Done, and the
   transcribed notes are scored like MIDI ones. Real graph, composer, generator and scorer; the
   transcriber is the harness's fake input. */

const NODE = "hands.lh.triads.root";
const id = (n: number): string => `01JBX0000000000000000${String(n).padStart(5, "0")}`;

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
  /** What the transcriber will report for the take. */
  heard: { notes: NoteEvent[] };
}

async function makeRig(opts: { transcribes?: boolean } = {}): Promise<Rig> {
  const heard = { notes: [] as NoteEvent[] };
  const h = await makeHarness({
    budgetSec: 600,
    inputSource: "mic",
    history: history(),
    ...(opts.transcribes === false ? {} : { takeNotes: () => heard.notes }),
  });
  const notation = new FakeNotation(h.clock);
  const compose = (input: ComposeInput) => {
    const plan = composeSession({ ...input, polyphonic: true });
    return {
      ...plan,
      orient: null,
      introductions: [],
      blocks: { ear: [], read: [], apply: plan.blocks.apply },
    };
  };
  return { h, machine: new SessionMachine({ ...h.deps, compose, notation }), heard };
}

async function until(r: Rig, pred: (s: SessionState) => boolean, maxMs = 60_000): Promise<void> {
  for (let t = 0; t < maxMs && !pred(r.machine.state); t += 50) await r.h.advance(50);
  if (!pred(r.machine.state)) {
    throw new Error(`condition not reached, stuck in ${JSON.stringify(r.machine.state)}`);
  }
}

const listening = (s: SessionState): boolean => s.kind === "listening";
const feedback = (s: SessionState): boolean => s.kind === "feedback";

/** The notes of the progression on screen, as a transcriber would report them. */
function chordNotes(target: ChordLineTarget, startMs: number): NoteEvent[] {
  const beatMs = 60000 / target.tempoBpm;
  return target.chords.flatMap((c) =>
    c.midi.map((m) => ({ ...noteAt(m, startMs + c.onsetBeats * beatMs, "mic"), offsetMs: 0 })),
  );
}

async function openChordItem(r: Rig): Promise<ChordLineTarget> {
  await r.machine.start();
  await until(r, listening);
  const target = r.machine.debug().expected?.play;
  if (target?.kind !== "chordLine") throw new Error("not a chord line item");
  return target;
}

const ofType = <T extends LearningEvent["type"]>(events: LearningEvent[], type: T) =>
  events.filter((e): e is Extract<LearningEvent, { type: T }> => e.type === type);

describe("chords on a transcribing mic", () => {
  it("offers a recording, ignores live mic notes, and scores the transcribed take", async () => {
    const r = await makeRig();
    const target = await openChordItem(r);
    const open = r.machine.state;
    if (open.kind !== "listening") throw new Error("not listening");
    expect(open.take).toBe("recording");

    const start = (r.machine.debug().stimulusEndMs ?? 0) + 700;
    // A stray single note heard live must not count: the take replaces live notes.
    for (const p of [40, 41, 42, 43]) r.h.input.emitNote(noteAt(p, start, "mic"));
    r.heard.notes = chordNotes(target, start);
    r.machine.answerDone();
    expect(r.machine.state).toMatchObject({ kind: "listening", take: "transcribing" });

    await until(r, feedback);
    const s = r.machine.state;
    if (s.kind !== "feedback") throw new Error("not feedback");
    expect(s.feedback.correct).toBe(true);
    const attempt = ofType(await logOf(r), "attempt.completed")[0];
    expect(attempt).toMatchObject({ nodeId: NODE, outcome: { correct: true }, inputSource: "mic" });
    expect(attempt?.errors).toBeUndefined();
  });

  it("does not end by itself when the chords are played: the learner says Done", async () => {
    const r = await makeRig();
    const target = await openChordItem(r);
    r.heard.notes = chordNotes(target, (r.machine.debug().stimulusEndMs ?? 0) + 700);
    await r.h.advance(12_000);
    expect(r.machine.state.kind).toBe("listening");
  });

  it("names a wrong chord tone found in the take", async () => {
    const r = await makeRig();
    const target = await openChordItem(r);
    const start = (r.machine.debug().stimulusEndMs ?? 0) + 700;
    const notes = chordNotes(target, start);
    // Shift the second chord's first tone by a semitone.
    const index = notes.findIndex((n) => n.onsetMs > start);
    r.heard.notes = notes.map((n, i) => (i === index ? { ...n, pitch: n.pitch + 1 } : n));
    r.machine.answerDone();
    await until(r, feedback);
    const attempt = ofType(await logOf(r), "attempt.completed")[0];
    expect(attempt?.outcome.correct).toBe(false);
    expect((attempt?.errors ?? []).some((e) => e.code.startsWith("chord."))).toBe(true);
  });

  it("ignores transcribed notes far outside the register of the item (overtone ghosts)", async () => {
    const r = await makeRig();
    const target = await openChordItem(r);
    const start = (r.machine.debug().stimulusEndMs ?? 0) + 700;
    r.heard.notes = [
      ...chordNotes(target, start),
      noteAt(96, start, "mic"),
      noteAt(100, start + 500, "mic"),
      noteAt(103, start + 900, "mic"),
    ];
    r.machine.answerDone();
    await until(r, feedback);
    const attempt = ofType(await logOf(r), "attempt.completed")[0];
    expect(attempt?.outcome.correct).toBe(true);
    expect(attempt?.errors).toBeUndefined();
  });

  it("scores an empty transcription as nothing played", async () => {
    const r = await makeRig();
    await openChordItem(r);
    r.heard.notes = [];
    r.machine.answerDone();
    await until(r, feedback);
    const attempt = ofType(await logOf(r), "attempt.completed")[0];
    expect(attempt?.outcome.correct).toBe(false);
  });

  it("ends the take at the response window without Done", async () => {
    const r = await makeRig();
    const target = await openChordItem(r);
    r.heard.notes = chordNotes(target, (r.machine.debug().stimulusEndMs ?? 0) + 700);
    await until(r, feedback, 120_000);
    const attempt = ofType(await logOf(r), "attempt.completed")[0];
    expect(attempt?.outcome.correct).toBe(true);
  });

  it("drops transcribed notes from before the answer window opened", async () => {
    const r = await makeRig();
    const target = await openChordItem(r);
    const early = chordNotes(target, (r.machine.debug().stimulusEndMs ?? 0) - 5000);
    r.heard.notes = early;
    r.machine.answerDone();
    await until(r, feedback);
    const attempt = ofType(await logOf(r), "attempt.completed")[0];
    expect(attempt?.outcome.correct).toBe(false);
  });

  it("listens live, as before, when the mic cannot transcribe", async () => {
    const r = await makeRig({ transcribes: false });
    await openChordItem(r);
    const s = r.machine.state;
    if (s.kind !== "listening") throw new Error("not listening");
    expect(s.take).toBeUndefined();
  });
});
