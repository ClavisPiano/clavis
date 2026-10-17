import {
  FIXTURE_BASS_F3_G_MAJOR,
  FIXTURE_GRAND_STAFF,
  FIXTURE_INTERVAL_C3_G3,
  composeSession,
  getGenerator,
  rate,
  type ComposeInput,
  type ExpectedResponse,
  type GenerateContext,
  type ItemInstance,
  type LearningEvent,
  type PlannedItem,
  type StimulusSpec,
} from "@clavis/core";
import { describe, expect, it } from "vitest";
import { SessionMachine, feedbackMarks, promptFor, type SessionState } from "./machine";
import { FakeNotation, logOf, makeHarness, noteAt, type Harness } from "./test-harness";

/* Reading items (T3.10): a fake NotationPort with a controllable show delay, stub read items
   (no real read generators are registered), and the real composer for the ear items. */

const READ_NODE = "read.bass.landmarks";

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
const EMPTY: StimulusSpec = { events: [] };

function readInstance(
  planned: PlannedItem,
  kind: "note" | "sequence" | "rhythm",
  stimulus: StimulusSpec = EMPTY,
): ItemInstance {
  const display = kind === "sequence" ? FIXTURE_INTERVAL_C3_G3 : FIXTURE_BASS_F3_G_MAJOR;
  const expected: ExpectedResponse =
    kind === "note"
      ? { play: { kind: "exactPitch", targetMidi: 54 }, responseWindowMs: 6000 }
      : kind === "sequence"
        ? {
            play: {
              kind: "sequence",
              midi: [48, 55],
              octaveAgnostic: false,
              degreeLabels: Array.from({ length: 12 }, (_, i) => String(i)),
            },
            responseWindowMs: 8000,
          }
        : {
            play: { kind: "rhythm", onsetsBeats: [0, 1, 2, 3], tempoBpm: 60, beatsPerBar: 4 },
            responseWindowMs: 9000,
          };
  return {
    itemId: planned.itemId,
    nodeId: planned.nodeId,
    generator: planned.generator,
    params: planned.params,
    presentation: { tonic: "G", mode: "major", tonicMidi: 55, seed: 7 },
    stimulus,
    expected,
    display,
    inputRange: { low: 36, high: 60 },
  };
}

interface ReadOptions {
  kind?: "note" | "sequence" | "rhythm";
  stimulus?: StimulusSpec;
  /** How many read items to plan. */
  count?: number;
  /** Keep the real ear items in the plan. */
  withEar?: boolean;
  notation?: "port" | "none";
  mode?: "instrument" | "away";
}

interface ReadHarness {
  h: Harness;
  machine: SessionMachine;
  notation: FakeNotation;
  planned: PlannedItem[];
}

async function makeReadHarness(opts: ReadOptions = {}): Promise<ReadHarness> {
  const h = await makeHarness({ budgetSec: 600, mode: opts.mode ?? "instrument" });
  const notation = new FakeNotation(h.clock);
  const planned: PlannedItem[] = Array.from({ length: opts.count ?? 1 }, (_, i) => ({
    itemId: `${READ_NODE}|stub${String(i)}`,
    nodeId: READ_NODE,
    generator: "bassNoteRead",
    params: { stub: i },
    isNew: false,
    estimatedSec: 5,
  }));
  const compose = (input: ComposeInput) => {
    const plan = composeSession(input);
    return {
      ...plan,
      orient: null,
      introductions: [],
      blocks: {
        ...plan.blocks,
        ear: opts.withEar ? plan.blocks.ear : [],
        read: planned,
      },
    };
  };
  const generate = (item: PlannedItem, ctx: GenerateContext): ItemInstance => {
    if (item.generator === "bassNoteRead") {
      return readInstance(item, opts.kind ?? "note", opts.stimulus);
    }
    const node = h.graph.nodes.find((n) => n.id === item.nodeId);
    if (!node) throw new Error("unknown node");
    return getGenerator(item.generator).generate(node, item.params, ctx);
  };
  const machine = new SessionMachine({
    ...h.deps,
    compose,
    generate,
    ...(opts.notation === "none" ? {} : { notation }),
  });
  return { h, machine, notation, planned };
}

/** Let the queued show start (it runs a few microtasks after `start()` returns). */
async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function until(
  h: Harness,
  machine: SessionMachine,
  pred: (s: SessionState) => boolean,
  maxMs = 30_000,
): Promise<SessionState> {
  for (let t = 0; t < maxMs && !pred(machine.state); t += 50) await h.advance(50);
  if (!pred(machine.state)) throw new Error(`stuck in ${JSON.stringify(machine.state)}`);
  return machine.state;
}

const listening = (s: SessionState): boolean => s.kind === "listening";
const feedback = (s: SessionState): boolean => s.kind === "feedback";

function byType<T extends LearningEvent["type"]>(
  events: LearningEvent[],
  type: T,
): Extract<LearningEvent, { type: T }>[] {
  return events.filter((e): e is Extract<LearningEvent, { type: T }> => e.type === type);
}

describe("reference time (R17)", () => {
  it("measures latency from when show resolves, not from item creation", async () => {
    const r = await makeReadHarness();
    r.notation.showDelayMs = 400;
    const createdAt = r.h.clock.ctxMs;
    await r.machine.start();
    await tick();
    expect(r.machine.state).toMatchObject({ kind: "presenting", prompt: "Play this note" });
    expect(r.notation.shows).toHaveLength(1);

    await until(r.h, r.machine, listening);
    const shownAt = createdAt + 400;
    expect(r.machine.debug().stimulusEndMs).toBe(shownAt);
    expect(r.machine.debug().phaseStartMs).toBe(shownAt);

    r.h.input.emitNote(noteAt(54, shownAt + 700, "mic"));
    await r.machine.settled();
    expect(r.machine.state.kind).toBe("feedback");
    const attempt = byType(await logOf(r), "attempt.completed")[0];
    expect(attempt?.outcome.correct).toBe(true);
    expect(attempt?.outcome.latencyMs).toBe(700);
  });

  it("an answer stamped before the notation was painted does not count", async () => {
    const r = await makeReadHarness();
    r.notation.showDelayMs = 400;
    await r.machine.start();
    await until(r.h, r.machine, listening);
    const shownAt = r.machine.debug().stimulusEndMs ?? 0;
    r.h.input.emitNote(noteAt(54, shownAt - 100, "mic"));
    await r.machine.settled();
    expect(r.machine.state.kind).toBe("listening");
  });

  it("plays nothing and has no gate tail for an empty stimulus", async () => {
    const r = await makeReadHarness();
    await r.machine.start();
    await r.machine.settled();
    expect(r.machine.state.kind).toBe("listening");
    expect(r.h.player.plays).toHaveLength(0);
    const shownAt = r.h.clock.ctxMs;
    expect(r.machine.debug().stimulusEndMs).toBe(shownAt);
    // An answer at the paint time is already accepted: there is no tail.
    r.h.input.emitNote(noteAt(54, shownAt, "mic"));
    await r.machine.settled();
    expect(r.machine.state.kind).toBe("feedback");
  });

  it("starts a count-in after show resolves, and its end is the reference", async () => {
    const r = await makeReadHarness({ kind: "rhythm", stimulus: COUNT_IN });
    r.notation.showDelayMs = 300;
    const createdAt = r.h.clock.ctxMs;
    await r.machine.start();
    await tick();
    await r.h.advance(250);
    expect(r.h.player.plays).toHaveLength(0);
    expect(r.machine.state).toMatchObject({ kind: "presenting", prompt: "Play the rhythm" });

    await r.h.advance(100);
    expect(r.h.player.plays).toHaveLength(1);
    const play = r.h.player.plays[0];
    expect(play?.startAt).toBeGreaterThanOrEqual((createdAt + 300) / 1000);
    expect(r.machine.debug().stimulusEndMs).toBe((play?.endAt ?? 0) * 1000);

    const state = await until(r.h, r.machine, listening);
    // The headphone tail (150 ms) follows the count-in.
    expect(r.h.clock.ctxMs).toBe((play?.endAt ?? 0) * 1000 + 150);
    expect(state).toMatchObject({ kind: "listening", prompt: "Play the rhythm" });
  });
});

describe("prompts and the item view", () => {
  it("the item view carries display and inputRange", async () => {
    const r = await makeReadHarness();
    await r.machine.start();
    await r.machine.settled();
    const s = r.machine.state;
    if (s.kind !== "listening") throw new Error("not listening");
    expect(s.item.display).toEqual(FIXTURE_BASS_F3_G_MAJOR);
    expect(s.item.inputRange).toEqual({ low: 36, high: 60 });
    expect(s.item.block).toBe("read");
  });

  const table: [string, "note" | "sequence" | "rhythm", "instrument" | "away", string][] = [
    ["exact pitch", "note", "instrument", "Play this note"],
    ["sequence", "sequence", "instrument", "Play these notes"],
    ["rhythm", "rhythm", "instrument", "Play the rhythm"],
    ["Away exact pitch", "note", "away", "Find it on the keyboard"],
    ["Away sequence", "sequence", "away", "Find it on the keyboard"],
    ["Away rhythm", "rhythm", "away", "Tap the rhythm"],
  ];
  it.each(table)("%s", async (_name, kind, mode, prompt) => {
    const r = await makeReadHarness({ kind, mode });
    await r.machine.start();
    await r.machine.settled();
    expect(r.machine.state).toMatchObject({ kind: "listening", prompt });
  });

  it("keeps the ear prompts for items without a display", () => {
    const expected: ExpectedResponse = {
      play: { kind: "exactPitch", targetMidi: 54 },
      responseWindowMs: 5000,
    };
    expect(promptFor("play", ["play"], expected, "instrument")).toBe("Play it");
    expect(promptFor("play", ["play"], expected, "away")).toBe("Tap it on the keyboard");
    expect(promptFor("sing", ["sing", "play"], expected, "instrument", true)).toBe("Sing it");
  });
});

describe("preload", () => {
  it("preloads once before the first show", async () => {
    const r = await makeReadHarness({ count: 2 });
    await r.machine.start();
    await r.machine.settled();
    expect(r.notation.calls.slice(0, 2)).toEqual(["preload", "show"]);
    expect(r.notation.count("preload")).toBe(1);
  });

  it("does not preload when no planned item needs notation", async () => {
    const h = await makeHarness({ budgetSec: 90 });
    const notation = new FakeNotation(h.clock);
    const machine = new SessionMachine({ ...h.deps, notation });
    await machine.start();
    expect(notation.calls).toEqual([]);
  });

  it("drops read items and notes it in the summary when preload fails", async () => {
    const r = await makeReadHarness({ count: 2, withEar: true });
    r.notation.preloadError = new Error("worker failed");
    await r.machine.start();
    r.machine.next(); // orient
    r.machine.next(); // intro
    await r.machine.settled();
    const s = r.machine.state;
    if (s.kind !== "presenting") throw new Error(`expected presenting, got ${s.kind}`);
    expect(s.item.block).toBe("ear");
    expect(s.item.total).toBe(r.machine.plan?.blocks.ear.length ?? -1);
    expect(r.notation.count("show")).toBe(0);
    r.machine.finish();
    await r.machine.settled();
    const end = r.machine.state;
    if (end.kind !== "summary") throw new Error("no summary");
    expect(end.summary.notes).toEqual([
      "Reading items were skipped because notation could not load.",
    ]);
    const presented = byType(await logOf(r), "item.presented");
    expect(presented.every((e) => e.block === "ear")).toBe(true);
  });

  it("does the same when read items are planned but there is no port", async () => {
    const r = await makeReadHarness({ notation: "none" });
    await r.machine.start();
    await r.machine.settled();
    const end = r.machine.state;
    if (end.kind !== "summary") throw new Error(`expected summary, got ${end.kind}`);
    expect(end.summary.notes).toEqual([
      "Reading items were skipped because notation could not load.",
    ]);
    expect(byType(await logOf(r), "item.presented")).toHaveLength(0);
  });

  it("has no notes when everything loads", async () => {
    const r = await makeReadHarness();
    await r.machine.start();
    await r.machine.settled();
    r.machine.finish();
    await r.machine.settled();
    const end = r.machine.state;
    if (end.kind !== "summary") throw new Error("no summary");
    expect(end.summary).not.toHaveProperty("notes");
  });
});

describe("pause and resume", () => {
  it("re-shows the notation and takes a new reference", async () => {
    const r = await makeReadHarness({ kind: "rhythm", stimulus: COUNT_IN });
    await r.machine.start();
    await until(r.h, r.machine, listening);
    const firstRef = r.machine.debug().stimulusEndMs ?? 0;
    expect(r.notation.count("show")).toBe(1);
    expect(r.h.player.plays).toHaveLength(1);

    r.machine.pause();
    expect(r.machine.state).toEqual({ kind: "paused", resumeTo: "listening" });
    await r.h.advance(20_000);
    r.machine.resume();
    expect(r.machine.state.kind).toBe("presenting");
    await until(r.h, r.machine, listening);
    expect(r.notation.count("show")).toBe(2);
    expect(r.h.player.plays).toHaveLength(2);
    expect(r.machine.debug().stimulusEndMs).toBeGreaterThan(firstRef + 20_000);
    expect(byType(await logOf(r), "item.presented")).toHaveLength(1);
  });

  it("takes the reference from the new paint time when the stimulus is empty", async () => {
    const r = await makeReadHarness();
    await r.machine.start();
    await r.machine.settled();
    const firstRef = r.machine.debug().stimulusEndMs ?? 0;
    r.machine.pause();
    await r.h.advance(10_000);
    r.notation.showDelayMs = 250;
    r.machine.resume();
    await tick();
    await until(r.h, r.machine, listening);
    expect(r.notation.count("show")).toBe(2);
    expect(r.machine.debug().stimulusEndMs).toBe(firstRef + 10_000 + 250);
  });

  it("ignores a paint that finishes while paused", async () => {
    const r = await makeReadHarness();
    r.notation.showDelayMs = 400;
    await r.machine.start();
    await r.h.advance(100);
    r.machine.pause();
    await r.h.advance(1000);
    expect(r.machine.state.kind).toBe("paused");
    expect(r.h.player.plays).toHaveLength(0);
  });
});

describe("event log", () => {
  it("writes the generated presentation and block read for a display item", async () => {
    const r = await makeReadHarness();
    await r.machine.start();
    await r.machine.settled();
    const presented = byType(await logOf(r), "item.presented");
    expect(presented).toHaveLength(1);
    expect(presented[0]).toMatchObject({
      block: "read",
      nodeId: READ_NODE,
      generator: "bassNoteRead",
      presentation: { tonic: "G", mode: "major", tonicMidi: 55, seed: 7 },
    });
    expect(presented[0]).not.toHaveProperty("display");
  });

  it("node.introduced carries a key family when the plan gives one", async () => {
    const h = await makeHarness({ budgetSec: 90 });
    const compose = (input: ComposeInput) => {
      const plan = composeSession(input);
      const first = plan.blocks.ear[0]?.nodeId ?? "";
      return {
        ...plan,
        introductions: [first],
        introductionKeyFamilies: { [first]: "B" as const },
      };
    };
    const machine = new SessionMachine({ ...h.deps, compose });
    await machine.start();
    const introduced = byType(await h.log(), "node.introduced");
    expect(introduced).toHaveLength(1);
    expect(introduced[0]?.keyFamily).toBe("B");
  });

  it("node.introduced has no key family for EAR introductions", async () => {
    const h = await makeHarness({ budgetSec: 90 });
    await h.machine.start();
    const introduced = byType(await h.log(), "node.introduced");
    expect(introduced.length).toBeGreaterThan(0);
    expect(introduced[0]).not.toHaveProperty("keyFamily");
  });
});

describe("feedback", () => {
  it("names both notes for a wrong exact-pitch answer and highlights the target", async () => {
    const r = await makeReadHarness();
    await r.machine.start();
    await r.machine.settled();
    const ref = r.machine.debug().stimulusEndMs ?? 0;
    r.h.input.emitNote(noteAt(52, ref + 500, "mic"));
    r.machine.answerDone();
    await r.machine.settled();
    const s = r.machine.state;
    if (s.kind !== "feedback") throw new Error("no feedback");
    expect(s.feedback.correct).toBe(false);
    expect(s.feedback.lines).toEqual(["You played E3. This note is F#3."]);
    expect(r.notation.marks).toEqual([[{ noteId: "n1", kind: "target" }]]);
  });

  it("explains an octave slip", async () => {
    const r = await makeReadHarness();
    await r.machine.start();
    await r.machine.settled();
    const ref = r.machine.debug().stimulusEndMs ?? 0;
    r.h.input.emitNote(noteAt(66, ref + 500, "mic"));
    r.machine.answerDone();
    await r.machine.settled();
    const s = r.machine.state;
    if (s.kind !== "feedback") throw new Error("no feedback");
    expect(s.feedback.lines).toEqual([
      "Right note, wrong octave. You played F#4. This note is F#3.",
    ]);
  });

  it("marks a correct answer right and hides the notation at the end", async () => {
    const r = await makeReadHarness();
    await r.machine.start();
    await r.machine.settled();
    const ref = r.machine.debug().stimulusEndMs ?? 0;
    r.h.input.emitNote(noteAt(54, ref + 500, "mic"));
    await r.machine.settled();
    expect(r.notation.marks).toEqual([[{ noteId: "n1", kind: "right" }]]);
    expect(r.notation.count("hide")).toBe(0);
    r.machine.finish();
    await r.machine.settled();
    expect(r.notation.count("hide")).toBe(1);
  });

  it("names the wrong note of a sequence and marks it", async () => {
    const r = await makeReadHarness({ kind: "sequence" });
    await r.machine.start();
    await r.machine.settled();
    const ref = r.machine.debug().stimulusEndMs ?? 0;
    r.h.input.emitNote(noteAt(48, ref + 500, "mic"));
    r.h.input.emitNote(noteAt(57, ref + 1000, "mic"));
    await until(r.h, r.machine, feedback);
    const s = r.machine.state;
    if (s.kind !== "feedback") throw new Error("no feedback");
    expect(s.feedback.lines).toEqual(["Note 2: you played A3; the target was G3"]);
    expect(r.notation.marks).toEqual([
      [
        { noteId: "n1", kind: "target" },
        { noteId: "n2", kind: "wrong" },
      ],
    ]);
  });

  it("replays the target audio for a display item, then the attempt", async () => {
    const r = await makeReadHarness({ kind: "sequence" });
    await r.machine.start();
    await r.machine.settled();
    const ref = r.machine.debug().stimulusEndMs ?? 0;
    r.h.input.emitNote(noteAt(48, ref + 500, "mic"));
    r.h.input.emitNote(noteAt(57, ref + 1000, "mic"));
    await until(r.h, r.machine, feedback);
    r.machine.replay();
    const spec = r.h.player.plays.at(-1)?.spec;
    const targets = spec?.events.filter((e) => e.role === "target");
    expect(targets?.map((e) => e.midi)).toEqual([[48], [55]]);
    expect(spec?.events.some((e) => e.role === undefined)).toBe(true);
  });

  it("replays count-in and rhythm for a rhythm item", async () => {
    const r = await makeReadHarness({ kind: "rhythm", stimulus: COUNT_IN });
    await r.machine.start();
    await until(r.h, r.machine, listening);
    r.machine.skip();
    await until(r.h, r.machine, feedback);
    r.machine.replay();
    const spec = r.h.player.plays.at(-1)?.spec;
    expect(spec?.events.filter((e) => e.role === "count-in")).toHaveLength(4);
    const targets = spec?.events.filter((e) => e.role === "target") ?? [];
    expect(targets.map((e) => e.atSec)).toEqual([4, 5, 6, 7]);
  });
});

describe("feedbackMarks", () => {
  it("marks only sequence wrong notes and everything right when correct", () => {
    expect(feedbackMarks(FIXTURE_INTERVAL_C3_G3, true, [])).toEqual([
      { noteId: "n1", kind: "right" },
      { noteId: "n2", kind: "right" },
    ]);
    expect(
      feedbackMarks(FIXTURE_INTERVAL_C3_G3, false, [
        { code: "sequence.wrong-note", detail: { index: 0 } },
        { code: "sequence.missing", detail: { index: 1 } },
      ]),
    ).toEqual([
      { noteId: "n1", kind: "wrong" },
      { noteId: "n2", kind: "target" },
    ]);
  });

  it("marks a performance's wrong or missed notes by id, a chord tone marking its chord", () => {
    const marks = feedbackMarks(FIXTURE_GRAND_STAFF, false, [
      { code: "note.wrong", detail: { id: "n2", measure: 1, beat: 2, hand: "rh" } },
      { code: "note.missed", detail: { id: "n6.1", measure: 1, beat: 1, hand: "lh" } },
      { code: "note.late", detail: { id: "n7", measure: 2, beat: 1, hand: "lh" } },
    ]);
    expect(marks.filter((m) => m.kind === "wrong").map((m) => m.noteId)).toEqual(["n2", "n6"]);
    expect(marks).toHaveLength(8);
  });
});

describe("Away reading on the tap keyboard (T3.11)", () => {
  /** Tap a key just after the gate opens, as the on-screen keyboard would. */
  async function tapAnswer(r: ReadHarness, midi: number): Promise<void> {
    await until(r.h, r.machine, listening);
    r.h.input.emitNote(noteAt(midi, r.h.clock.ctxMs + 100, "tap"));
    await until(r.h, r.machine, feedback);
  }

  it("scores an Away read item exact-pitch from a tap", async () => {
    const r = await makeReadHarness({ mode: "away" });
    await r.machine.start();
    await tapAnswer(r, 54);
    const attempts = byType(await logOf(r), "attempt.completed");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome.correct).toBe(true);
    expect(attempts[0]?.inputSource).toBe("tap");
    expect(attempts[0]?.errors).toBeUndefined();
    const s = r.machine.state;
    if (s.kind !== "feedback") throw new Error("no feedback");
    expect(s.item.block).toBe("read");
  });

  it("an octave-above tap is pitch.octave, not a plain miss", async () => {
    const r = await makeReadHarness({ mode: "away" });
    await r.machine.start();
    await tapAnswer(r, 66);
    const attempt = byType(await logOf(r), "attempt.completed")[0];
    expect(attempt?.outcome.correct).toBe(false);
    expect(attempt?.errors?.map((e) => e.code)).toEqual(["pitch.octave"]);
  });

  it("applies the Away rating cap to read items (R3)", async () => {
    const r = await makeReadHarness({ mode: "away" });
    await r.machine.start();
    await tapAnswer(r, 54);
    const attempt = byType(await logOf(r), "attempt.completed")[0];
    if (!attempt) throw new Error("no attempt");
    expect(r.h.service.state.sessions[attempt.sessionId]?.mode).toBe("away");
    expect(r.h.service.state.cards[attempt.itemId]?.reps).toBe(1);
    // The reducer rates with the session's mode: a fast correct answer is easy only at the
    // instrument.
    const target = r.h.graph.nodes.find((n) => n.id === READ_NODE)?.targetLatencyMs;
    const fast = { ...attempt.outcome, latencyMs: 1 };
    const opts = target === undefined ? {} : { targetLatencyMs: target };
    expect(rate(fast, { mode: "instrument", ...opts })).toBe(
      target === undefined ? "good" : "easy",
    );
    expect(rate(fast, { mode: "away", ...opts })).toBe("good");
  });
});
