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
