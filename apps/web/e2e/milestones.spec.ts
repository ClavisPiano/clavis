import { expect, test, type Page } from "@playwright/test";
import { runToSummary } from "./session-helpers";

/*
 * T6.3: a learner one attempt short of mastering "Degrees 1, 3, 5" finishes a session that masters
 * it, sees the milestone on the summary, and finds it again on /progress. The mastery window is 20
 * instrument attempts at 90% accuracy and a median under 1.5 s, so 19 quick correct answers on an
 * earlier day plus one in the session do it. Item `degree=5` is left unseen so it is presented
 * as a new item.
 */

test.setTimeout(150_000);

const NODE = "ear.degrees.major.135";
const DEVICE = "seed-device";
const STATEMENT = "You can hear and sing scale degrees 1, 3 and 5 in any major key.";
let seq = 0;
const eid = (): string => `01JBX0000000000000002${String(++seq).padStart(5, "0")}`;

async function seedOneShort(page: Page): Promise<void> {
  const base = { deviceId: DEVICE };
  const sessionId = "01JBX0000000000000SESS0002";
  // Well over a day ago, so the seeded day is never today's learner day.
  const at = Date.now() - 30 * 3_600_000;
  const events: Record<string, unknown>[] = [
    {
      ...base,
      id: eid(),
      at,
      type: "session.started",
      v: 1,
      sessionId,
      mode: "instrument",
      budgetSec: 720,
      key: { tonic: "C", mode: "major" },
      tzOffsetMin: 0,
      contentVersion: "seed",
    },
    { ...base, id: eid(), at: at + 500, type: "node.introduced", v: 1, sessionId, nodeId: NODE },
  ];
  for (let i = 0; i < 19; i++) {
    const t = at + 2000 + i * 5000;
    const itemId = `${NODE}|degree=${i % 2 === 0 ? "1" : "3"}`;
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
        v: 1,
        sessionId,
        itemId,
        nodeId: NODE,
        outcome: { correct: true, latencyMs: 1000, retries: 0 },
        inputSource: "midi",
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

test("a fresh learner has no milestones yet", async ({ page }) => {
  await page.goto("/progress");
  await expect(page.getByTestId("milestones-empty")).toBeVisible();
  await expect(page.getByTestId("milestone")).toHaveCount(0);
});

test("mastering a node in a session shows its milestone in the summary and on /progress", async ({
  page,
}) => {
  await seedOneShort(page);

  // One short: learning, not mastered, and the statement is waiting under "Within reach".
  await page.goto("/progress");
  await expect(page.getByTestId("milestone")).toHaveCount(0);
  await expect(
    page.locator(`[data-testid="milestone-upcoming"][data-node="${NODE}"]`),
  ).toContainText(STATEMENT);

  await page.goto("/session?input=fake&budget=90");
  await page.getByTestId("start").click();
  await runToSummary(page);

  await expect(page.getByTestId("summary")).toBeVisible();
  const block = page.getByTestId("milestones");
  await expect(block).toBeVisible();
  await expect(block.getByTestId("milestone")).toHaveCount(1);
  await expect(block.getByTestId("milestone")).toHaveText(STATEMENT);

  await page.goto("/progress");
  const earned = page.locator(`[data-testid="milestones"] [data-testid="milestone"]`);
  await expect(earned).toHaveCount(1);
  await expect(earned).toContainText(STATEMENT);
  await expect(earned).toContainText(/\d{4}-\d{2}-\d{2}/);
  await expect(page.locator(`[data-testid="milestone-upcoming"][data-node="${NODE}"]`)).toHaveCount(
    0,
  );
});
