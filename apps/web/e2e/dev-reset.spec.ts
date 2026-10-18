import { expect, test } from "@playwright/test";
import { seedLearner } from "./read-helpers";

// /dev/reset: wipe learning progress (keeping setup) or everything, with an optional backup first.

test("reset progress keeps settings, offers a backup and brings the placement offer back", async ({
  page,
}) => {
  await seedLearner(page, [{ nodeId: "ear.degrees.major.135" }], { newItemsPerDay: 7 });
  await expect(page.getByTestId("event-count")).toHaveText("5");
  await page.goto("/");
  await expect(page.getByTestId("placement-offer")).toHaveCount(0);

  await page.goto("/dev/reset");
  await page.getByTestId("reset-progress").click();
  await expect(page.getByTestId("reset-backup")).toBeChecked();
  const download = page.waitForEvent("download");
  await page.getByTestId("reset-confirm-button").click();
  expect((await download).suggestedFilename()).toMatch(/\.json$/);

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("placement-offer")).toBeVisible();
  await page.goto("/dev/state");
  // device.registered and settings.changed survive.
  await expect(page.getByTestId("event-count")).toHaveText("2");
  await page.goto("/settings");
  await expect(page.getByTestId("new-items-per-day")).toHaveValue("7");
});

test("reset everything without a backup leaves a fresh install", async ({ page }) => {
  await seedLearner(page, [{ nodeId: "ear.degrees.major.135" }], { newItemsPerDay: 7 });
  await page.goto("/dev/reset");
  await page.getByTestId("reset-everything").click();
  await page.getByTestId("reset-backup").uncheck();
  let downloaded = false;
  page.on("download", () => {
    downloaded = true;
  });
  await page.getByTestId("reset-confirm-button").click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("placement-offer")).toBeVisible();
  await page.goto("/dev/state");
  // Only the new device registration.
  await expect(page.getByTestId("event-count")).toHaveText("1");
  await page.goto("/settings");
  await expect(page.getByTestId("new-items-per-day")).not.toHaveValue("7");
  expect(downloaded).toBe(false);
});

test("reset warns that synced events come back when signed in", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("clavis.signedIn", "1");
  });
  await page.route("**/api/sync/pull**", (route) =>
    route.fulfill({ json: { events: [], lastSeq: 0, hasMore: false } }),
  );
  await page.route("**/api/sync/push", (route) =>
    route.fulfill({ json: { accepted: 0, duplicates: 0, lastSeq: 0 } }),
  );
  await page.goto("/dev/reset");
  await expect(page.getByTestId("synced-notice")).toContainText("stay on the server");
  await page.goto("/dev/state");
  await expect(page.getByTestId("event-count")).toBeVisible();
});

test("reset shows no sync warning when signed out", async ({ page }) => {
  await page.goto("/dev/reset");
  await expect(page.getByTestId("reset-progress")).toBeVisible();
  await expect(page.getByTestId("synced-notice")).toHaveCount(0);
});
