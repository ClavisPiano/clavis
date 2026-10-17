import { expect, test, type Page } from "@playwright/test";
import { answerCurrentPhase, runToSummary, singCurrentPhase } from "./session-helpers";

/*
 * T6.6 (R28): a learner whose "Degrees 1, 3, 5" is fluent is asked "Was that right?" before
 * feedback on the first answer of a session to it, and once ten answers have been judged, /progress
 * shows how often their call matched the result. The seed is 20 quick correct answers on an
 * earlier day (fluent, but one session is not enough for mastered), nine of them self-assessed:
 * seven agreeing and two saying "wrong" about a right answer. Item `degree=5` is left unseen.
 */

test.setTimeout(150_000);

const NODE = "ear.degrees.major.135";
const DEVICE = "seed-device";
let seq = 0;
const eid = (): string => `01JBX0000000000000003${String(++seq).padStart(5, "0")}`;

async function seedFluent(page: Page): Promise<void> {
  const base = { deviceId: DEVICE };
  const sessionId = "01JBX0000000000000SESS0003";
  const at = Date.now() - 30 * 3_600_000;
  const events: Record<string, unknown>[] = [
    {
      ...base,
      id: eid(),
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
    { ...base, id: eid(), at: at + 500, type: "node.introduced", v: 1, sessionId, nodeId: NODE },
  ];
  for (let i = 0; i < 20; i++) {
    const t = at + 2000 + i * 5000;
    const itemId = `${NODE}|degree=${i % 2 === 0 ? "1" : "3"}`;
    const selfAssessment = i < 7 ? "right" : i < 9 ? "wrong" : undefined;
    events.push(
      {
        ...base,
        id: eid(),
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
        id: eid(),
        at: t + 1000,
        type: "attempt.completed",
        v: 2,
        sessionId,
        itemId,
        nodeId: NODE,
        outcome: { correct: true, latencyMs: 1000, retries: 0 },
        inputSource: "midi",
        ...(selfAssessment ? { selfAssessment } : {}),
      },
    );
  }
  events.push({
    ...base,
    id: eid(),
    at: at + 120_000,
    type: "session.ended",
    v: 1,
    sessionId,
    reason: "completed",
  });
  const doc = {
    format: "clavis-events",
    formatVersion: 1,
    exportedAt: new Date(at).toISOString(),
    deviceId: DEVICE,
    contentVersion: "seed",
    reducerVersion: 1,
    events,
  };
  const count = String(events.length);
  await page.goto("/dev/state");
  await expect(page.getByTestId("event-count")).toHaveText("1");
  await page.getByTestId("import-file").setInputFiles({
    name: "seed.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(doc)),
  });
  await expect(page.getByTestId("import-status")).toContainText(`${count} valid`);
  await page.getByTestId("import").click();
  await expect(page.getByTestId("import-status")).toContainText(`${count} inserted`);
}

/** Answer items until the self-assessment question shows. */
async function answerUntilAsked(page: Page): Promise<void> {
  const session = page.getByTestId("session");
  const deadline = Date.now() + 100_000;
  while (Date.now() < deadline) {
    const state = await session.getAttribute("data-state");
    if (state === "selfAssess") return;
    if (state === "summary" || state === "error") throw new Error(`session ended in ${state}`);
    if (state === "orient" || state === "intro") {
      await page
        .getByTestId("continue")
        .click({ timeout: 2_000 })
        .catch(() => undefined);
    } else if (state === "feedback") {
      const next = page.getByTestId("next");
      if (await next.isVisible()) await next.click({ timeout: 2_000 }).catch(() => undefined);
      else await page.waitForTimeout(100);
    } else if (state === "listening") {
      const phase = await page.evaluate(() => window.__clavisSession?.phase ?? "");
      if (phase === "listening-practice") {
        await page
          .getByTestId("ready")
          .click({ timeout: 2_000 })
          .catch(() => undefined);
        continue;
      }
      if (phase === "listening-sing") await singCurrentPhase(page);
      else await answerCurrentPhase(page);
      await page.waitForFunction((before) => window.__clavisSession?.phase !== before, phase, {
        timeout: 20_000,
      });
    } else {
      await page.waitForTimeout(100);
    }
  }
  throw new Error("never asked to self-assess");
}

test("answer, say it was right, then see calibration on /progress", async ({ page }) => {
  await seedFluent(page);

  // Nine judged answers are not enough to show anything yet.
  await page.goto("/progress");
  await expect(page.getByTestId("trends")).toBeVisible();
  await expect(page.getByTestId("calibration")).toHaveCount(0);

  await page.goto("/session?input=fake&budget=90");
  await page.getByTestId("start").click();
  await answerUntilAsked(page);

  const ask = page.getByTestId("self-assess");
  await expect(ask).toContainText("Was that right?");
  // The result stays hidden until the learner has answered.
  await expect(page.getByTestId("feedback")).toHaveCount(0);
  await ask.getByTestId("self-assess-right").click();
  await expect(page.getByTestId("feedback")).toBeVisible();
  await expect(page.getByTestId("result")).toHaveText("Correct");

  await runToSummary(page);
  await expect(page.getByTestId("summary")).toBeVisible();

  await page.goto("/progress");
  const section = page.getByTestId("calibration");
  await expect(section).toBeVisible();
  const text = (await section.textContent()) ?? "";
  const judged = Number(/From the (\d+) answers/.exec(text)?.[1]);
  expect(judged).toBeGreaterThanOrEqual(10);
  // Every live answer was right and called right; the two seeded "wrong" calls were not.
  await expect(page.getByTestId("calibration-agreement")).toHaveText(
    `Your call matched the result ${String(Math.round(((judged - 2) / judged) * 100))}% of the time`,
  );
  await expect(page.getByTestId("calibration-over")).toContainText("0");
  await expect(page.getByTestId("calibration-under")).toContainText("2");
  await expect(page.getByTestId("spark-calibration").locator("circle")).not.toHaveCount(0);
});
