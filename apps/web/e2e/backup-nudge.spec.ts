import { expect, test, type Page } from "@playwright/test";
import { seedLearner } from "./read-helpers";

// T8.1: a learner with no account and unprotected storage is nudged to save a backup.

/** Enough events (the nudge needs 30) that there is something to lose. */
async function seedEnough(page: Page): Promise<void> {
  const nodes = Array.from({ length: 30 }, () => ({ nodeId: "ear.degrees.major.135" }));
  await seedLearner(page, nodes, { newItemsPerDay: 7 });
}

test("an unsynced learner is nudged, can back up, and the card goes away", async ({ page }) => {
  await seedEnough(page);
  await page.addInitScript(() => {
    localStorage.setItem("clavis.storage-persist", "denied");
  });
  await page.goto("/");
  const nudge = page.getByTestId("backup-nudge");
  await expect(nudge).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByTestId("backup-now").click();
  expect((await download).suggestedFilename()).toMatch(/\.json$/);
  await expect(nudge).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("start-session")).toBeVisible();
  await expect(nudge).toHaveCount(0);
});

test("not now hides the card, also after a reload", async ({ page }) => {
  await seedEnough(page);
  await page.addInitScript(() => {
    localStorage.setItem("clavis.storage-persist", "denied");
  });
  await page.goto("/");
  const nudge = page.getByTestId("backup-nudge");
  await expect(nudge).toBeVisible();
  await page.getByTestId("backup-snooze").click();
  await expect(nudge).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("start-session")).toBeVisible();
  await expect(nudge).toHaveCount(0);
});

test("no card when storage is persistent", async ({ page }) => {
  await seedEnough(page);
  await page.addInitScript(() => {
    localStorage.setItem("clavis.storage-persist", "granted");
  });
  await page.goto("/");
  await expect(page.getByTestId("start-session")).toBeVisible();
  await expect(page.getByTestId("backup-nudge")).toHaveCount(0);
});

test("no card for a signed-in learner", async ({ page }) => {
  await seedEnough(page);
  await page.addInitScript(() => {
    localStorage.setItem("clavis.storage-persist", "denied");
    localStorage.setItem("clavis.signedIn", "1");
  });
  await page.route("**/api/sync/**", (route) =>
    route.fulfill({ json: { events: [], lastSeq: 0, hasMore: false, accepted: 0, duplicates: 0 } }),
  );
  await page.goto("/");
  await expect(page.getByTestId("start-session")).toBeVisible();
  await expect(page.getByTestId("backup-nudge")).toHaveCount(0);
});
