import { expect, test } from "@playwright/test";

test("/dev/state renders versions and nodes, and Export downloads a file", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
  });
  page.on("pageerror", (err) => {
    errors.push(`pageerror: ${err.message}`);
  });

  await page.goto("/dev/state");
  await expect(page.getByRole("heading", { name: "Learner state" })).toBeVisible();
  await expect(page.getByTestId("content-version")).not.toBeEmpty();
  await expect(page.getByTestId("node-row").first()).toBeVisible();
  expect(await page.getByTestId("node-row").count()).toBeGreaterThan(5);
  await expect(page.getByTestId("event-count")).toHaveText("1");

  if (/webkit|safari/i.test(testInfo.project.name)) {
    // Blob-URL downloads are not reliably surfaced as Playwright download events on WebKit.
    await page.getByTestId("export").click();
  } else {
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("export").click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^clavis-events-[0-9A-Z]{26}-\d{8}-\d{4}\.json$/);
  }
  await expect(page.getByTestId("export-status")).toContainText("Exported 1 events");

  expect(errors).toEqual([]);
});

test("/dev index links to learner state", async ({ page }) => {
  await page.goto("/dev");
  await page.getByRole("link", { name: "Learner state" }).click();
  await expect(page.getByRole("heading", { name: "Learner state" })).toBeVisible();
});
