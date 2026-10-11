import { expect, test } from "@playwright/test";

// An installed PWA has no address bar, so the dev pages are reached from Settings.
test("seven taps on the version reveal developer tools, which persist and can be hidden", async ({
  page,
}) => {
  await page.goto("/settings");
  await expect(page.getByTestId("dev-tools-link")).toHaveCount(0);

  const version = page.getByTestId("app-version");
  for (let i = 0; i < 6; i++) await version.click();
  await expect(page.getByTestId("dev-tools-link")).toHaveCount(0);
  await version.click();
  await expect(page.getByTestId("dev-tools-link")).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("dev-tools-link")).toBeVisible();

  await page.getByTestId("dev-tools-link").click();
  await expect(page).toHaveURL(/\/dev\/?$/);
  await page.getByRole("link", { name: "Learner state" }).click();
  await expect(page.getByTestId("dev-nav").getByRole("link", { name: "Dev pages" })).toBeVisible();
  await page.getByTestId("dev-back").click();
  await expect(page).toHaveURL(/\/$/);

  await page.goto("/settings");
  await page.getByTestId("dev-tools-off").click();
  await expect(page.getByTestId("dev-tools-link")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("dev-tools-link")).toHaveCount(0);
});
