import type { LearningEvent } from "@clavis/core";
import { describe, expect, it } from "vitest";
import { choiceQuestion, promptFor, type SessionState } from "./machine";
import { makeHarness, noteAt, T0, type Harness } from "./test-harness";

/* Choice items (R21): chordQuality is answered with buttons, in both modes. The learner has the
   triad node introduced and everything before it placed, so the plan is chordQuality items. */

const id = (n: number): string => `01JBX0000000000000000${String(n).padStart(5, "0")}`;

function triadHistory(): LearningEvent[] {
  const at = T0 - 3 * 86_400_000;
  const base = { deviceId: "seed-device", v: 1 };
  const sessionId = id(1);
  return [
    {
      ...base,
      id: id(2),
      at,
      type: "session.started",
      sessionId,
      mode: "instrument",
      budgetSec: 720,
      key: { tonic: "C", mode: "major" },
      tzOffsetMin: 0,
      contentVersion: "seed",
    },
    {
      ...base,
      id: id(3),
      at: at + 500,
      type: "placement.completed",
      placementId: id(4),
      results: {
        "ear.degrees.major.135": "mastered",
        "ear.degrees.major.diatonic": "mastered",
        "ear.bass.I-IV-V-vi": "mastered",
      },
    },
    {
      ...base,
      id: id(5),
      at: at + 1000,
      type: "node.introduced",
      sessionId,
      nodeId: "ear.quality.triad",
    },
    { ...base, id: id(6), at: at + 60_000, type: "session.ended", sessionId, reason: "completed" },
  ] as unknown as LearningEvent[];
}

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

/** Start a session and wait for the first item to be listening. */
async function toFirstItem(h: Harness): Promise<void> {
  await h.machine.start();
  for (let i = 0; i < 40; i++) {
    const s = await until(h, (x) => ["listening", "orient", "intro", "error"].includes(x.kind));
    if (s.kind === "listening") return;
    if (s.kind === "error") throw new Error(s.message);
    h.machine.next();
  }
  throw new Error("never reached an item");
}

const correctId = (h: Harness): string => {
  const play = h.machine.debug().expected?.play;
  if (play?.kind !== "choice") throw new Error("not a choice item");
  return play.correct;
};
const wrongId = (h: Harness): string => {
  const play = h.machine.debug().expected?.play;
  if (play?.kind !== "choice") throw new Error("not a choice item");
  return play.options.find((o) => o.id !== play.correct)?.id ?? "";
};

describe.each(["away", "instrument"] as const)("choice item in %s mode", (mode) => {
  const harness = (): Promise<Harness> =>
    makeHarness({ mode, budgetSec: 120, history: triadHistory() });

  it("shows the options and the question, with the keyboard answer replaced by buttons", async () => {
    const h = await harness();
    await toFirstItem(h);
    const s = h.machine.state;
    if (s.kind !== "listening") throw new Error("not listening");
    expect(s.item.generator).toBe("chordQuality");
    expect(s.item.choices).toEqual([
      { id: "major", label: "Major" },
      { id: "minor", label: "Minor" },
    ]);
    expect(s.prompt).toBe("Major or minor?");
    expect(s.phaseCount).toBe(1);
  });

  it("scores the right option as correct, timed from the end of the chord, as a tap", async () => {
    const h = await harness();
    await toFirstItem(h);
    const end = h.machine.debug().stimulusEndMs ?? 0;
    await h.advance(Math.max(0, end + 700 - h.clock.ctxMs));
    h.machine.answerChoice(correctId(h));
    await until(h, (x) => x.kind === "feedback");
    const attempt = (await h.log()).find((e) => e.type === "attempt.completed");
    expect(attempt).toMatchObject({
      outcome: { correct: true, retries: 0 },
      inputSource: "tap",
      nodeId: "ear.quality.triad",
    });
    const latency = (attempt as { outcome: { latencyMs: number } }).outcome.latencyMs;
    expect(latency).toBeGreaterThanOrEqual(600);
    expect(latency).toBeLessThanOrEqual(800);
    expect(h.machine.state).toMatchObject({ kind: "feedback", feedback: { correct: true } });
  });

  it("scores the wrong option as incorrect and says what was chosen", async () => {
    const h = await harness();
    await toFirstItem(h);
    h.machine.answerChoice(wrongId(h));
    await until(h, (x) => x.kind === "feedback");
    const s = h.machine.state;
    if (s.kind !== "feedback") throw new Error("not feedback");
    expect(s.feedback.correct).toBe(false);
    expect(s.feedback.lines).toHaveLength(1);
    expect(s.feedback.lines[0]).toMatch(/^You chose (major|minor); it was (major|minor)$/);
    const attempt = (await h.log()).find((e) => e.type === "attempt.completed");
    expect(attempt).toMatchObject({
      outcome: { correct: false },
      errors: [{ code: "choice.wrong" }],
    });
  });

  it("ignores notes, unknown options and a second pick", async () => {
    const h = await harness();
    await toFirstItem(h);
    const start = h.clock.ctxMs + 1000;
    h.input.emitNote(noteAt(60, start, h.input.source));
    h.input.emitNote(noteAt(64, start + 400, h.input.source));
    h.input.emitNote(noteAt(67, start + 800, h.input.source));
    await h.advance(2000);
    expect(h.machine.state.kind).toBe("listening");
    h.machine.answerChoice("augmented");
    expect(h.machine.state.kind).toBe("listening");
    const right = correctId(h);
    h.machine.answerChoice(right);
    h.machine.answerChoice(wrongId(h));
    await until(h, (x) => x.kind === "feedback");
    expect(h.machine.state).toMatchObject({ kind: "feedback", feedback: { correct: true } });
  });

  it("times out with no pick after the response window", async () => {
    const h = await harness();
    await toFirstItem(h);
    const window = h.machine.debug().expected?.responseWindowMs ?? 0;
    await h.advance(window + 500);
    await until(h, (x) => x.kind === "feedback");
    const attempt = (await h.log()).find((e) => e.type === "attempt.completed");
    expect(attempt).toMatchObject({
      outcome: { correct: false, latencyMs: window },
      errors: [{ code: "response.timeout" }],
    });
  });

  it("ignores answerChoice on a note item", async () => {
    const h = await makeHarness({ mode, budgetSec: 90 });
    await toFirstItem(h);
    h.machine.answerChoice("major");
    expect(h.machine.state.kind).toBe("listening");
  });
});

describe("choice prompts", () => {
  it("joins the option labels into a question", () => {
    const opt = (id: string, label: string) => ({ id, label });
    expect(choiceQuestion([opt("a", "Major"), opt("b", "Minor")])).toBe("Major or minor?");
    expect(choiceQuestion([opt("a", "Major"), opt("b", "Minor"), opt("c", "Diminished")])).toBe(
      "Major, minor or diminished?",
    );
  });

  it("promptFor asks the question for a choice item in either mode", () => {
    const expected = {
      play: {
        kind: "choice" as const,
        options: [
          { id: "major", label: "Major" },
          { id: "minor", label: "Minor" },
        ],
        correct: "major",
      },
      responseWindowMs: 8000,
    };
    for (const mode of ["away", "instrument"] as const) {
      expect(promptFor("play", ["play"], expected, mode)).toBe("Major or minor?");
    }
  });
});
