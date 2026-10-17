import { createUlidGenerator, type LearningEvent } from "@clavis/core";
import { describe, expect, it } from "vitest";
import { T0, makeHarness, playCorrect, singCorrect, type Harness } from "./test-harness";

/* T6.3: the summary names the capability milestones first earned in the session. */

const NODE = "ear.degrees.major.135";
const STATEMENT = "You can hear and sing scale degrees 1, 3 and 5 in any major key.";
const DAY = 86_400_000;

/**
 * 19 quick correct answers on an earlier day. The window is 20 instrument attempts, so one more
 * correct answer in two sessions' time masters the node. Degree 5 is left unseen so the session
 * presents it as a new item.
 */
function oneShort(): LearningEvent[] {
  const at = T0 - 2 * DAY;
  const newId = createUlidGenerator({
    now: () => at,
    randomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => i + 90),
  });
  const base = { deviceId: "device-0" };
  const sessionId = newId();
  const out: LearningEvent[] = [
    {
      ...base,
      id: newId(),
      at,
      type: "session.started",
      v: 2,
      sessionId,
      mode: "instrument",
      budgetSec: 720,
      key: { tonic: "C", mode: "major" },
      tzOffsetMin: 0,
      contentVersion: "seed",
    },
    { ...base, id: newId(), at: at + 500, type: "node.introduced", v: 1, sessionId, nodeId: NODE },
  ];
  for (let i = 0; i < 19; i++) {
    const t = at + 2000 + i * 5000;
    const itemId = `${NODE}|degree=${i % 2 === 0 ? "1" : "3"}`;
    out.push(
      {
        ...base,
        id: newId(),
        at: t,
        type: "item.presented",
        v: 1,
        sessionId,
        itemId,
        nodeId: NODE,
        generator: "degreeId",
        block: "ear",
        isNew: i < 2,
        presentation: {},
      },
      {
        ...base,
        id: newId(),
        at: t + 1000,
        type: "attempt.completed",
        v: 2,
        sessionId,
        itemId,
        nodeId: NODE,
        outcome: { correct: true, latencyMs: 1000, retries: 0 },
        inputSource: "midi",
      },
    );
  }
  out.push({
    ...base,
    id: newId(),
    at: at + 120_000,
    type: "session.ended",
    v: 1,
    sessionId,
    reason: "completed",
  });
  return out;
}

async function until(h: Harness, pred: () => boolean, maxMs = 60_000): Promise<void> {
  for (let t = 0; t < maxMs && !pred(); t += 50) await h.advance(50);
  if (!pred()) throw new Error(`stuck in ${JSON.stringify(h.machine.state)}`);
}

/** From presenting to feedback, answering every phase correctly (as machine.test.ts does). */
async function playItem(h: Harness): Promise<void> {
  for (;;) {
    for (let t = 0; t < 60_000; t += 50) {
      const k = h.machine.state.kind;
      if (k === "listening" || k === "feedback") break;
      await h.advance(50);
    }
    const s = h.machine.state;
    if (s.kind === "feedback") return;
    if (s.kind !== "listening") throw new Error(`stuck in ${s.kind}`);
    const expected = h.machine.debug().expected;
    if (!expected) throw new Error("no expected response");
    const start = h.clock.ctxMs + 200;
    if (s.phase === "sing") singCorrect(h.input, expected, start);
    else playCorrect(h.input, expected, start);
    await h.machine.settled();
    if (h.machine.state.kind === "feedback") return;
    const phase = s.phase;
    await until(h, () => {
      const x = h.machine.state;
      return !(x.kind === "listening" && x.phase === phase);
    });
  }
}

/** Answer everything correctly until the summary. */
async function runCorrect(h: Harness): Promise<void> {
  await h.machine.start();
  for (let guard = 0; guard < 40 && h.machine.state.kind !== "summary"; guard++) {
    const s = h.machine.state;
    if (s.kind === "orient" || s.kind === "intro") h.machine.next();
    else if (s.kind === "presenting" || s.kind === "listening") await playItem(h);
    else if (s.kind === "feedback") h.machine.next();
    await h.advance(50);
  }
  await until(h, () => h.machine.state.kind === "summary");
}

describe("summary milestones", () => {
  it("names the milestone a session earns", async () => {
    const h = await makeHarness({ budgetSec: 90, history: oneShort(), idSalt: 31 });
    expect(h.service.state.nodes[NODE]?.state).not.toBe("mastered");
    await runCorrect(h);
    const s = h.machine.state;
    if (s.kind !== "summary") throw new Error("no summary");
    expect(h.service.state.nodes[NODE]?.state).toBe("mastered");
    expect(s.summary.milestones?.map((m) => [m.nodeId, m.statement])).toEqual([[NODE, STATEMENT]]);
  });

  it("shows no milestone when nothing was mastered", async () => {
    const h = await makeHarness({ budgetSec: 90, idSalt: 32 });
    await runCorrect(h);
    const s = h.machine.state;
    if (s.kind !== "summary") throw new Error("no summary");
    expect(s.summary.milestones).toBeUndefined();
  });

  it("shows none when the deps carry no milestone content", async () => {
    const h = await makeHarness({ budgetSec: 90, history: oneShort(), idSalt: 33, milestones: [] });
    await runCorrect(h);
    const s = h.machine.state;
    if (s.kind !== "summary") throw new Error("no summary");
    expect(s.summary.milestones).toBeUndefined();
  });
});
