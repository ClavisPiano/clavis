import { expect, test, type Page } from "@playwright/test";

/*
 * A session whose plan has no items is not a session: it shows "Nothing is due right now" and
 * writes nothing. The learner is seeded as already at the daily new-item cap (three new items
 * presented earlier today, no answers, so no cards): nothing is due and no new item is allowed.
 */

// Fixed timezone so the seeded learner day matches the one the page computes.
test.use({ timezoneId: "UTC" });

const ID_PREFIX = "01JBX0000000000000000";
const NODE = "ear.degrees.major.135";

async function seedAtCap(page: Page): Promise<number> {
  const at = Date.now() - 120_000;
  const id = (n: number): string => `${ID_PREFIX}${String(n).padStart(5, "0")}`;
  const sessionId = id(1);
  const base = { deviceId: "seed-device", v: 1 };
  const events = [
    {
      ...base,
      v: 2,
      id: id(2),
      at: at - 1000,
      type: "settings.changed",
      patch: { newItemsPerDay: 3 },
    },
    {
      ...base,
      v: 2,
      id: id(3),
      at,
      type: "session.started",
      sessionId,
      mode: "instrument",
      budgetSec: 720,
      key: { tonic: "C", mode: "major" },
      tzOffsetMin: 0,
      contentVersion: "seed",
    },
    { ...base, id: id(4), at: at + 1, type: "node.introduced", sessionId, nodeId: NODE },
    ...[1, 3, 5].map((degree, i) => ({
      ...base,
      id: id(5 + i),
      at: at + 1000 * (i + 1),
      type: "item.presented",
      sessionId,
      itemId: `${NODE}|degree=${String(degree)}`,
      nodeId: NODE,
      generator: "degreeSing",
      block: "ear",
      isNew: true,
      presentation: {},
    })),
    {
      ...base,
      id: id(8),
      at: at + 10_000,
      type: "session.ended",
      sessionId,
      reason: "abandoned",
    },
  ];
  const doc = {
    format: "clavis-events",
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    deviceId: "seed-device",
    contentVersion: "seed",
    reducerVersion: 1,
    events,
  };
  await page.goto("/dev/state");
  await expect(page.getByTestId("event-count")).toHaveText("1");
  await page.getByTestId("import-file").setInputFiles({
    name: "seed.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(doc)),
  });
  const count = String(events.length);
  await expect(page.getByTestId("import-status")).toContainText(`${count} valid events`);
  await page.getByTestId("import").click();
  await expect(page.getByTestId("import-status")).toContainText(`${count} inserted`);
  return events.length;
}

test("a learner with nothing due sees the Nothing-due screen and no session is recorded", async ({
  page,
}) => {
  const seeded = await seedAtCap(page);

  await page.goto("/");
  await expect(page.getByTestId("start-session")).toContainText("Nothing is due right now");

  await page.goto("/session?input=fake&budget=90");
  await page.getByTestId("start").click();
  await expect(page.getByTestId("nothing")).toBeVisible();
  await expect(page.getByTestId("nothing")).toContainText("Nothing is due right now");
  await expect(page.getByTestId("session")).toHaveAttribute("data-state", "nothing");
  // No finish button, progress bar or time left on this screen.
  await expect(page.getByTestId("finish")).toHaveCount(0);
  await expect(page.getByTestId("time-left")).toHaveCount(0);
  // Same next steps as the summary: nothing is started, so only Learn and Done.
  await expect(page.getByTestId("keep-going")).toHaveCount(0);
  await expect(page.getByTestId("learn-more")).toBeVisible();
  await expect(page.getByTestId("learn-more")).toHaveAttribute("href", /learn=1/);
  await expect(page.getByTestId("home")).toHaveText("Done for today");

  await page.goto("/dev/events");
  await expect(page.getByTestId("events")).toBeVisible();
  await expect(page.getByTestId("event")).toHaveCount(seeded + 1); // the seed plus the device.registered event
  await expect(
    page.locator('[data-testid="event"]').filter({ hasText: "session.started" }),
  ).toHaveCount(1);
});

test("Learn something new from the Nothing-due screen starts a real session", async ({ page }) => {
  await seedAtCap(page);
  await page.goto("/session?input=fake&budget=90");
  await page.getByTestId("start").click();
  await page.getByTestId("learn-more").click();
  await expect(page.getByTestId("session-intro")).toContainText("new material");
  await page.getByTestId("start").click();
  await expect(page.getByTestId("session")).not.toHaveAttribute("data-state", "nothing");
  await expect(page.getByTestId("session")).not.toHaveAttribute("data-state", "idle");
});
