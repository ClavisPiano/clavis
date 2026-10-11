import { expect, test, type Page } from "@playwright/test";

/*
 * Away READ on the on-screen keyboard (T3.11). The real reading generators are not registered
 * until T3.15, so the session runs with `?readstub=1&audio=silent`, a test seam that plans one stub
 * READ item (F3 on the bass staff in G major, which sounds F#3 = MIDI 54, input range 36..60).
 * The learner is seeded through the /dev/state import, with the landmarks node introduced. Input
 * is the real tap adapter on the real on-screen keyboard.
 */

const NOW = Date.parse("2026-10-14T12:00:00Z");

async function seedReadLearner(page: Page): Promise<void> {
  const doc = {
    format: "clavis-events",
    formatVersion: 1,
    exportedAt: new Date(NOW).toISOString(),
    deviceId: "seed-device",
    contentVersion: "seed",
    reducerVersion: 1,
    events: [
      {
        id: "01JBX00000000000000000R001",
        deviceId: "seed-device",
        at: NOW - 3 * 86_400_000,
        type: "session.started",
        v: 1,
        sessionId: "01JBX00000000000000000R002",
        mode: "instrument",
        budgetSec: 720,
        key: { tonic: "C", mode: "major" },
        tzOffsetMin: 0,
        contentVersion: "seed",
      },
      {
        id: "01JBX00000000000000000R003",
        deviceId: "seed-device",
        at: NOW - 3 * 86_400_000 + 1000,
        type: "node.introduced",
        v: 1,
        sessionId: "01JBX00000000000000000R002",
        nodeId: "read.bass.landmarks",
        keyFamily: "A",
      },
      {
        id: "01JBX00000000000000000R004",
        deviceId: "seed-device",
        at: NOW - 3 * 86_400_000 + 60_000,
        type: "session.ended",
        v: 1,
        sessionId: "01JBX00000000000000000R002",
        reason: "completed",
      },
    ],
  };
  await page.goto("/dev/state");
  await expect(page.getByTestId("event-count")).toHaveText("1");
  await page.getByTestId("import-file").setInputFiles({
    name: "seed.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(doc)),
  });
  await expect(page.getByTestId("import-status")).toContainText("3 valid events");
  await page.getByTestId("import").click();
  await expect(page.getByTestId("import-status")).toContainText("3 inserted");
}

async function startAwayRead(page: Page): Promise<void> {
  await page.goto("/session?mode=away&input=tap&audio=silent&readstub=1&budget=60");
  await page.getByTestId("start").click();
  // The node was introduced in the seed, so there is no intro card and no Orient block.
  await expect(page.getByTestId("prompt")).toHaveText("Find it on the keyboard");
  await expect(page.getByTestId("notation-slot")).toHaveAttribute("data-block", "read");
}

test.describe("Away READ", () => {
  test.setTimeout(60_000);

  test("keyboard covers the item's register and does not reveal the target", async ({ page }) => {
    await seedReadLearner(page);
    await startAwayRead(page);
    // C2 (MIDI 36) is reachable, and the keys run an octave either side of the 36..60 range.
    await expect(page.locator('[data-midi="36"]')).toHaveAttribute("aria-label", "C 2");
    await expect(page.locator('[data-midi="24"]')).toHaveCount(1);
    await expect(page.locator('[data-midi="72"]')).toHaveCount(1);
    await expect(page.locator('[data-midi="20"]')).toHaveCount(0);
    await expect(page.locator(".key.highlight")).toHaveCount(0);
  });

  test("a correct tap passes", async ({ page }) => {
    await seedReadLearner(page);
    await startAwayRead(page);
    await page.getByRole("button", { name: "F sharp 3" }).click();
    await expect(page.getByTestId("feedback")).toHaveAttribute("data-correct", "true");
    await expect(page.getByTestId("result")).toHaveText("Correct");
  });

  test("a tap an octave above gives pitch.octave", async ({ page }) => {
    await seedReadLearner(page);
    await startAwayRead(page);
    await page.getByRole("button", { name: "F sharp 4" }).click();
    // A wrong note does not end the item by itself: the learner can retry or tap Done.
    await page.getByTestId("done").click();
    await expect(page.getByTestId("feedback")).toHaveAttribute("data-correct", "false");
    await expect(page.getByTestId("tip")).toContainText("Right letter, wrong octave");
  });
});
