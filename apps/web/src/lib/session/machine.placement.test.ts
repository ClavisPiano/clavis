import type { LearningEvent, ScoreSpec } from "@clavis/core";
import { describe, expect, it } from "vitest";
import type { NotationMark, NotationPort } from "../notation/port";
import type { SessionState } from "./machine";
import { makeHarness, playCorrect, type Harness, type HarnessOptions } from "./test-harness";

/* Placement mode (T3.16, R19): the real placement plan, generators, scorer and reducer with a
   manual clock. Answers are chosen per item: fast and right, slow and right, or wrong. */

type Policy = "fast" | "slow" | "wrong";

class FakeNotation implements NotationPort {
  shown: ScoreSpec[] = [];
  marks: NotationMark[][] = [];
  hides = 0;
  preload(): Promise<void> {
    return Promise.resolve();
  }
  show(score: ScoreSpec): Promise<void> {
    this.shown.push(score);
    return Promise.resolve();
  }
  highlight(marks: NotationMark[]): void {
    this.marks.push(marks);
  }
  hide(): void {
    this.hides++;
  }
}

const EAR_135 = "ear.degrees.major.135";
const EAR_DIATONIC = "ear.degrees.major.diatonic";
const READ_LANDMARKS = "read.bass.landmarks";
const READ_STEPS = "read.bass.steps";
const READ_SKIPS = "read.bass.skips";
const HANDS_LH = "hands.lh.triads.root";
const HANDS_COORD = "hands.coord.basic";

async function until(
  h: Harness,
  pred: (s: SessionState) => boolean,
  maxMs = 60_000,
): Promise<SessionState> {
  for (let t = 0; t < maxMs && !pred(h.machine.state); t += 50) await h.advance(50);
  if (!pred(h.machine.state)) {
    throw new Error(`condition not reached, stuck in ${JSON.stringify(h.machine.state)}`);
  }
  return h.machine.state;
}

/**
 * Answer every presented item by `policy(nodeId, indexWithinNode)` until the summary shows.
 * Returns the node id of each item in presentation order.
 */
async function runPlacement(
  h: Harness,
  policy: (nodeId: string, nth: number) => Policy,
  stopAfter = Number.POSITIVE_INFINITY,
): Promise<string[]> {
  await h.machine.start();
  const order: string[] = [];
  const perNode = new Map<string, number>();
  let lastPosition = 0;
  while (order.length < stopAfter) {
    const s = await until(
      h,
      (x) =>
        x.kind === "summary" ||
        x.kind === "error" ||
        (x.kind === "listening" && x.item.position > lastPosition),
    );
    if (s.kind === "error") throw new Error(s.message);
    if (s.kind !== "listening") break;
    lastPosition = s.item.position;
    const nodeId = s.item.nodeId;
    const nth = perNode.get(nodeId) ?? 0;
    perNode.set(nodeId, nth + 1);
    order.push(nodeId);
    const how = policy(nodeId, nth);
    if (how === "wrong") {
      h.machine.skip();
    } else {
      if (how === "slow") await h.advance(6000);
      const debug = h.machine.debug();
      const expected = debug.expected;
      if (!expected) throw new Error("no expected response");
      // HANDS items keep time with a count-in: the first beat falls one beat after it ends.
      const kind = expected.play?.kind;
      const counted = kind === "chordLine" || kind === "performance";
      playCorrect(
        h.input,
        expected,
        counted ? (debug.stimulusEndMs ?? 0) + 700 : h.clock.ctxMs + 200,
      );
    }
    await h.machine.settled();
  }
  return order;
}

async function placementEvents(
  h: Harness,
): Promise<Extract<LearningEvent, { type: "placement.completed" }>[]> {
  return (await h.log()).filter(
    (e): e is Extract<LearningEvent, { type: "placement.completed" }> =>
      e.type === "placement.completed",
  );
}

function opts(extra: HarnessOptions = {}): HarnessOptions {
  return { placement: true, notation: new FakeNotation(), ...extra };
}

describe("placement mode: completion", () => {
  it("writes exactly one placement.completed and nothing else, with every node mastered", async () => {
    const notation = new FakeNotation();
    const h = await makeHarness(opts({ headphones: undefined, askHeadphones: true, notation }));
    const order = await runPlacement(h, () => "fast");

    expect(h.machine.state.kind).toBe("summary");
    expect(notation.shown).toHaveLength(10);
    const log = await h.log();
    expect(log.map((e) => e.type)).toEqual(["placement.completed"]);
    const [event] = await placementEvents(h);
    expect(event?.results).toEqual({
      [EAR_135]: "mastered",
      [EAR_DIATONIC]: "mastered",
      [READ_LANDMARKS]: "mastered",
      [READ_STEPS]: "mastered",
      [READ_SKIPS]: "mastered",
    });
    // 9 + 8 + 4 + 3 + 3 items, EAR before READ.
    expect(order).toHaveLength(27);
    expect(order.slice(0, 17).every((n) => n.startsWith("ear."))).toBe(true);
    expect(order.slice(17).every((n) => n.startsWith("read."))).toBe(true);

    const summary = h.machine.state.kind === "summary" ? h.machine.state.summary : undefined;
    expect(summary?.reason).toBe("completed");
    expect(summary?.placed?.map((p) => [p.nodeId, p.state])).toEqual([
      [EAR_135, "mastered"],
      [EAR_DIATONIC, "mastered"],
      [READ_LANDMARKS, "mastered"],
      [READ_STEPS, "mastered"],
      [READ_SKIPS, "mastered"],
    ]);
    expect(summary?.placed?.every((p) => p.title !== p.nodeId)).toBe(true);
    expect(h.service.state.nodes[EAR_135]?.state).toBe("mastered");
  });

  it("has no intro cards, warm-up, headphones question or session events", async () => {
    const h = await makeHarness(opts({ headphones: undefined, askHeadphones: true }));
    await runPlacement(h, () => "fast");
    const kinds = new Set(h.states.map((s) => s.kind));
    for (const k of ["intro", "orient", "headphones"] as const) expect(kinds.has(k)).toBe(false);
    const types = new Set((await h.log()).map((e) => e.type));
    for (const t of [
      "session.started",
      "session.ended",
      "item.presented",
      "attempt.completed",
      "node.introduced",
      "settings.changed",
    ]) {
      expect(types.has(t as LearningEvent["type"])).toBe(false);
    }
  });

  it("shows only a brief correct or incorrect tick and moves on by itself", async () => {
    const h = await makeHarness(opts());
    await runPlacement(h, (_n, nth) => (nth === 0 ? "wrong" : "fast"), 2);
    const ticks = h.states.filter(
      (s): s is Extract<SessionState, { kind: "feedback" }> => s.kind === "feedback",
    );
    expect(ticks.length).toBeGreaterThan(0);
    for (const t of ticks) {
      expect(t.feedback.lines).toEqual([]);
      expect(t.feedback.tip).toBeUndefined();
      expect(t.feedback.autoAdvance).toBe(true);
      expect(t.canReplay).toBe(false);
    }
    expect(ticks.some((t) => !t.feedback.correct)).toBe(true);
  });

  it("generates in C major", async () => {
    const h = await makeHarness(opts());
    await runPlacement(h, () => "fast", 3);
    const first = h.player.plays[0];
    // The cadence of C major starts on a C chord: C3 or C4 range, pitch class 0.
    expect(first?.spec.events[0]?.midi.map((m) => m % 12)).toContain(0);
  });
});

describe("placement mode: early stop", () => {
  it("stops EAR at an available 1-3-5 (no diatonic) and READ at an available landmarks", async () => {
    const h = await makeHarness(opts());
    const order = await runPlacement(h, () => "wrong");
    expect(order.filter((n) => n === EAR_135)).toHaveLength(9);
    expect(order).not.toContain(EAR_DIATONIC);
    expect(order.filter((n) => n === READ_LANDMARKS)).toHaveLength(4);
    expect(order).not.toContain(READ_STEPS);
    expect(order).not.toContain(READ_SKIPS);
    expect(order).toHaveLength(13);
    const [event] = await placementEvents(h);
    expect(event?.results).toEqual({ [EAR_135]: "available", [READ_LANDMARKS]: "available" });
    expect((await h.log()).map((e) => e.type)).toEqual(["placement.completed"]);
  });

  it("skips the diatonic stage when 1-3-5 is fluent but not mastered", async () => {
    // Two wrong of nine is fluent (7 correct).
    const h = await makeHarness(opts());
    const order = await runPlacement(h, (n, nth) =>
      n === EAR_135 && nth < 2 ? "wrong" : n.startsWith("read.") ? "wrong" : "fast",
    );
    expect(order).not.toContain(EAR_DIATONIC);
    const [event] = await placementEvents(h);
    expect(event?.results[EAR_135]).toBe("fluent");
    expect(event?.results[EAR_DIATONIC]).toBeUndefined();
  });

  it("scores a slow but correct 1-3-5 as fluent, not mastered", async () => {
    const h = await makeHarness(opts());
    const order = await runPlacement(h, (n) => (n === EAR_135 ? "slow" : "wrong"));
    expect(order).not.toContain(EAR_DIATONIC);
    const [event] = await placementEvents(h);
    expect(event?.results[EAR_135]).toBe("fluent");
  });

  it("stops READ at the first available stage", async () => {
    const h = await makeHarness(opts());
    const order = await runPlacement(h, (n) => (n.startsWith("ear.") ? "fast" : "wrong"));
    expect(order.filter((n) => n === EAR_DIATONIC)).toHaveLength(8);
    expect(order.filter((n) => n === READ_LANDMARKS)).toHaveLength(4);
    expect(order).not.toContain(READ_STEPS);
    expect(order).not.toContain(READ_SKIPS);
    const [event] = await placementEvents(h);
    expect(event?.results).toEqual({
      [EAR_135]: "mastered",
      [EAR_DIATONIC]: "mastered",
      [READ_LANDMARKS]: "available",
    });
  });
});

describe("placement mode: abandon and degraded runs", () => {
  it("writes nothing when finished early", async () => {
    const h = await makeHarness(opts());
    await runPlacement(h, () => "fast", 4);
    h.machine.finish();
    await h.machine.settled();
    expect(await h.log()).toEqual([]);
    const s = h.machine.state;
    expect(s.kind).toBe("summary");
    if (s.kind === "summary") {
      expect(s.summary.reason).toBe("abandoned");
      expect(s.summary.placed).toBeUndefined();
    }
  });

  it("writes nothing when stopped before the first answer", async () => {
    const h = await makeHarness(opts());
    await h.machine.start();
    await until(h, (s) => s.kind === "listening");
    h.machine.finish();
    await h.machine.settled();
    expect(await h.log()).toEqual([]);
  });

  it("places EAR only, and says so, when notation cannot load", async () => {
    const failing: NotationPort = {
      preload: () => Promise.reject(new Error("no worker")),
      show: () => Promise.resolve(),
      highlight: () => undefined,
      hide: () => undefined,
    };
    const h = await makeHarness(opts({ notation: failing }));
    const order = await runPlacement(h, () => "fast");
    expect(order).toHaveLength(17);
    const [event] = await placementEvents(h);
    expect(Object.keys(event?.results ?? {}).sort()).toEqual([EAR_DIATONIC, EAR_135].sort());
    const s = h.machine.state;
    expect(s.kind === "summary" ? s.summary.notes?.length : 0).toBe(1);
  });

  it("never lowers a node that was placed higher before", async () => {
    const h = await makeHarness(opts());
    await runPlacement(h, () => "fast");
    expect(h.service.state.nodes[EAR_135]?.state).toBe("mastered");

    // A second run on the same learner, answering everything wrong.
    const again = await makeHarness({
      ...opts({ idSalt: 40 }),
      history: await h.log(),
    });
    await runPlacement(again, () => "wrong");
    for (const id of [EAR_135, EAR_DIATONIC, READ_LANDMARKS, READ_STEPS, READ_SKIPS]) {
      expect(again.service.state.nodes[id]?.state).toBe("mastered");
    }
    expect((await again.log()).filter((e) => e.type === "placement.completed")).toHaveLength(2);
  });
});

describe("placement mode: HANDS section (T5.9, R27)", () => {
  const midi = (extra: HarnessOptions = {}): HarnessOptions =>
    opts({ inputSource: "midi", ...extra });

  it("runs with MIDI input: chords, then hands together, each placed at fluent", async () => {
    const h = await makeHarness(midi());
    const order = await runPlacement(h, () => "fast");
    expect(order).toHaveLength(29);
    expect(order.slice(27)).toEqual([HANDS_LH, HANDS_COORD]);

    // Presented as in a session's Apply block, in C major, with a count-in.
    const listening = h.states.filter(
      (s): s is Extract<SessionState, { kind: "listening" }> =>
        s.kind === "listening" && s.item.nodeId.startsWith("hands."),
    );
    expect(listening.map((s) => [s.item.generator, s.item.block])).toEqual([
      ["lhPattern", "apply"],
      ["coordTask", "apply"],
    ]);
    expect(listening[1]?.item.bothHands).toBe(true);
    expect(listening.map((s) => s.item.chords?.map((c) => c.symbol))).toEqual([
      ["C", "F", "G", "C"],
      ["C", "F", "G", "C"],
    ]);

    const [event] = await placementEvents(h);
    expect(event?.results[HANDS_LH]).toBe("fluent");
    expect(event?.results[HANDS_COORD]).toBe("fluent");
    expect((await h.log()).map((e) => e.type)).toEqual(["placement.completed"]);
    const s = h.machine.state;
    expect(s.kind === "summary" && s.summary.placed?.slice(-2).map((p) => p.state)).toEqual([
      "fluent",
      "fluent",
    ]);
    expect(h.service.state.nodes[HANDS_COORD]?.state).toBe("fluent");
  });

  it("places hands together at available when only the chords are right", async () => {
    const h = await makeHarness(midi());
    const order = await runPlacement(h, (n) => (n === HANDS_COORD ? "wrong" : "fast"));
    expect(order.slice(-2)).toEqual([HANDS_LH, HANDS_COORD]);
    const [event] = await placementEvents(h);
    expect(event?.results[HANDS_LH]).toBe("fluent");
    expect(event?.results[HANDS_COORD]).toBe("available");
  });

  it("skips hands together after a wrong chord item, which places the chords at available", async () => {
    const h = await makeHarness(midi());
    const order = await runPlacement(h, (n) => (n.startsWith("hands.") ? "wrong" : "fast"));
    expect(order.at(-1)).toBe(HANDS_LH);
    expect(order).not.toContain(HANDS_COORD);
    const [event] = await placementEvents(h);
    expect(event?.results[HANDS_LH]).toBe("available");
    expect(event?.results[HANDS_COORD]).toBeUndefined();
  });

  it("runs even when EAR and READ stop at their first stage", async () => {
    const h = await makeHarness(midi());
    const order = await runPlacement(h, (n) => (n.startsWith("hands.") ? "fast" : "wrong"));
    expect(order).toHaveLength(13 + 2);
    const [event] = await placementEvents(h);
    expect(event?.results).toEqual({
      [EAR_135]: "available",
      [READ_LANDMARKS]: "available",
      [HANDS_LH]: "fluent",
      [HANDS_COORD]: "fluent",
    });
  });

  it("is skipped with the microphone, so the hands roots stay as they were (R9)", async () => {
    const h = await makeHarness(opts({ inputSource: "mic" }));
    const before = h.service.state.nodes[HANDS_LH]?.state;
    const order = await runPlacement(h, () => "fast");
    expect(order).toHaveLength(27);
    expect(order.some((n) => n.startsWith("hands."))).toBe(false);
    const [event] = await placementEvents(h);
    expect(Object.keys(event?.results ?? {}).some((n) => n.startsWith("hands."))).toBe(false);
    expect(before).toBe("available");
    expect(h.service.state.nodes[HANDS_LH]?.state).toBe("available");
    expect(h.service.state.nodes[HANDS_COORD]?.state).not.toBe("fluent");
  });

  it("is skipped, with READ, when notation cannot load", async () => {
    const failing: NotationPort = {
      preload: () => Promise.reject(new Error("no worker")),
      show: () => Promise.resolve(),
      highlight: () => undefined,
      hide: () => undefined,
    };
    const h = await makeHarness(midi({ notation: failing }));
    const order = await runPlacement(h, () => "fast");
    expect(order).toHaveLength(17);
    const s = h.machine.state;
    expect(s.kind === "summary" ? s.summary.notes : []).toEqual([
      "Reading and hands were skipped because notation could not load.",
    ]);
  });

  it("re-running never lowers a hands node placed before", async () => {
    const h = await makeHarness(midi());
    await runPlacement(h, (n) => (n.startsWith("hands.") ? "fast" : "wrong"));
    const again = await makeHarness({ ...midi({ idSalt: 40 }), history: await h.log() });
    await runPlacement(again, () => "wrong");
    const events = await placementEvents(again);
    // The first run placed the chords at fluent, this one at available.
    expect(events.map((e) => e.results[HANDS_LH]).sort()).toEqual(["available", "fluent"]);
    expect(again.service.state.nodes[HANDS_LH]?.state).toBe("fluent");
    expect(again.service.state.nodes[HANDS_COORD]?.state).toBe("fluent");
  });
});
