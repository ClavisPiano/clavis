import { createUlidGenerator, type LearningEvent } from "@clavis/core";
import { describe, expect, it } from "vitest";
import type { NotationMark, NotationPort } from "../notation/port";
import { SessionMachine } from "./machine";
import { T0, makeHarness, type Harness } from "./test-harness";

/* B: an empty plan is not a session. C: replay of the plan shape from a real bug report, an ear
   strand stuck on rhythm echo plus a READ node being introduced by "Learn something new". */

const DAY = 86_400_000;
const LANDMARKS = "read.bass.landmarks";
const RHYTHM = "ear.rhythm.echo";

class QuietNotation implements NotationPort {
  shows = 0;
  marks = 0;
  hidden = 0;
  preload(): Promise<void> {
    return Promise.resolve();
  }
  show(): Promise<void> {
    this.shows++;
    return Promise.resolve();
  }
  highlight(marks: NotationMark[]): void {
    this.marks = marks.length;
  }
  hide(): void {
    this.hidden++;
  }
}

function placement(results: Record<string, "fluent" | "mastered" | "available">): LearningEvent {
  const newId = createUlidGenerator({
    now: () => T0 - 2 * DAY,
    randomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => i + 200),
  });
  return {
    id: newId(),
    deviceId: "device-0",
    at: T0 - 2 * DAY,
    type: "placement.completed",
    v: 1,
    placementId: newId(),
    results,
  };
}

/** Skip every item, taking each intro and feedback screen, until the summary. */
async function skipThrough(h: Harness): Promise<void> {
  await h.machine.start();
  for (let guard = 0; guard < 400 && h.machine.state.kind !== "summary"; guard++) {
    const s = h.machine.state;
    if (s.kind === "nothing" || s.kind === "error") return;
    if (s.kind === "orient" || s.kind === "intro" || s.kind === "feedback") h.machine.next();
    else if (s.kind === "presenting" || s.kind === "listening") h.machine.skip();
    await h.advance(50);
  }
}

describe("an empty plan (B)", () => {
  it("writes no events and lands in the nothing state", async () => {
    const empty = await makeHarness({ budgetSec: 90, history: [placement({})], idSalt: 5 });
    const machine = new SessionMachine({ ...empty.deps, compose: emptyCompose(empty) });
    const before = (await empty.log()).length;
    await machine.start();
    expect(machine.state.kind).toBe("nothing");
    expect(empty.player.loads).toBe(0);
    expect((await empty.log()).length).toBe(before);
    // Finish and pause are no-ops on this screen.
    machine.finish();
    machine.pause();
    await machine.settled();
    expect(machine.state.kind).toBe("nothing");
    expect((await empty.log()).length).toBe(before);
  });
});

function emptyCompose(h: Harness): typeof h.deps.compose {
  return (input) => {
    const plan = h.deps.compose(input);
    return {
      ...plan,
      orient: null,
      introductions: [],
      introductionKeyFamilies: {},
      blocks: { ear: [], read: [], apply: null },
    };
  };
}

describe("Learn something new with a READ introduction (C)", () => {
  it("shows the intro card and presents the read items after the ear items", async () => {
    const history0 = [placement({ "ear.degrees.major.135": "fluent", [LANDMARKS]: "available" })];
    const notation = new QuietNotation();

    const first = await makeHarness({ budgetSec: 720, history: history0, notation });
    await skipThrough(first);
    expect(first.machine.plan?.introductions).toEqual([RHYTHM]);
    const history = await first.log();

    const h = await makeHarness({
      budgetSec: 720,
      history,
      idSalt: 77,
      extraNewItems: 5,
      notation,
    });
    await skipThrough(h);
    const plan = h.machine.plan;
    expect(plan?.introductions).toEqual([LANDMARKS]);
    const readCount = plan?.blocks.read.length ?? 0;
    const earCount = plan?.blocks.ear.length ?? 0;
    expect(earCount).toBeGreaterThan(0);
    expect(readCount).toBeGreaterThan(0);

    const intros = h.states.flatMap((s) => (s.kind === "intro" ? [s.nodeId] : []));
    expect(intros).toEqual([LANDMARKS]);
    // The card comes after the whole ear block, right before the first reading item.
    const firstIntro = h.states.findIndex((s) => s.kind === "intro");
    const itemsBefore = new Set(
      h.states
        .slice(0, firstIntro)
        .flatMap((s) => (s.kind === "presenting" ? [s.item.position] : [])),
    );
    expect(itemsBefore.size).toBe(earCount);

    const events = (await h.log()).filter((e) => !history.some((o) => o.id === e.id));
    const presented = events.filter((e) => e.type === "item.presented");
    expect(presented.filter((e) => e.block === "read")).toHaveLength(readCount);
    expect(presented).toHaveLength(earCount + readCount);
    expect(events.filter((e) => e.type === "node.introduced").map((e) => e.nodeId)).toEqual([
      LANDMARKS,
    ]);
    expect(notation.shows).toBeGreaterThanOrEqual(readCount);
    const ended = events.filter((e) => e.type === "session.ended");
    expect(ended).toHaveLength(1);
    expect(h.machine.state.kind).toBe("summary");
    if (h.machine.state.kind === "summary") {
      expect(h.machine.state.summary.items).toBe(earCount + readCount);
    }
  });

  it("Finish after the first attempts ends as completed with the rest of the plan unplayed", async () => {
    // The only path found that yields `completed` this early: the learner taps Finish.
    const history0 = [placement({ "ear.degrees.major.135": "fluent", [LANDMARKS]: "available" })];
    const notation = new QuietNotation();
    const first = await makeHarness({ budgetSec: 720, history: history0, notation });
    await skipThrough(first);
    const history = await first.log();
    const h = await makeHarness({
      budgetSec: 720,
      history,
      idSalt: 91,
      extraNewItems: 5,
      notation,
    });
    await h.machine.start();
    h.machine.next(); // orient
    for (let i = 0; i < 2; i++) {
      for (let g = 0; g < 100 && h.machine.state.kind !== "listening"; g++) await h.advance(50);
      h.machine.skip();
      await h.advance(50);
      h.machine.next();
    }
    h.machine.finish();
    await h.machine.settled();
    const events = (await h.log()).filter((e) => !history.some((o) => o.id === e.id));
    const end = events.filter((e) => e.type === "session.ended");
    expect(end.map((e) => e.reason)).toEqual(["completed"]);
    expect(events.filter((e) => e.type === "node.introduced").map((e) => e.nodeId)).toEqual([
      LANDMARKS,
    ]);
  });
});
