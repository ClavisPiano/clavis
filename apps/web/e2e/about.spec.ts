import { expect, test, type Page } from "@playwright/test";

async function waitForServiceWorkerControl(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

test("settings links to the licences and source page", async ({ page }) => {
  await page.goto("/settings");
  await page.getByTestId("about-link").click();
  await expect(page).toHaveURL(/\/settings\/about$/);
  await expect(page.getByRole("heading", { name: "Licences and source code" })).toBeVisible();

  await expect(page.getByTestId("source-link")).toHaveAttribute(
    "href",
    "https://github.com/ClavisPiano/clavis",
  );
  await expect(page.getByTestId("licence-file-code")).toHaveAttribute(
    "href",
    /\/blob\/main\/LICENSE$/,
  );
  await expect(page.getByTestId("licence-file-content")).toHaveAttribute(
    "href",
    /\/blob\/main\/LICENSE-CONTENT$/,
  );

  // The Settings tab stays highlighted on the nested page.
  await expect(
    page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Settings" }),
  ).toHaveAttribute("aria-current", "page");

  const verovio = page.getByTestId("lgpl-notice");
  await expect(verovio).toContainText("Lesser General Public License");
  await expect(page.getByTestId("lgpl-source")).toHaveAttribute(
    "href",
    "https://github.com/rism-digital/verovio/tree/version-6.3.0",
  );
  await expect(page.getByTestId("lib-dexie")).toContainText("Apache-2.0");
  await expect(page.getByTestId("asset-splendid-grand-piano")).toContainText("Public domain");
});

test("the full licence texts load on demand", async ({ page }) => {
  await page.goto("/settings/about");
  await expect(page.getByTestId("notices-text")).toHaveCount(0);
  await page.getByTestId("notices").locator("summary").click();
  const text = page.getByTestId("notices-text");
  await expect(text).toContainText("verovio 6.3.0, LGPL-3.0-or-later");
  await expect(text).toContainText("GNU LESSER GENERAL PUBLIC LICENSE");
  await expect(text).toContainText("GNU GENERAL PUBLIC LICENSE");
});

test("the licence texts open offline", async ({ page, context }) => {
  await page.goto("/settings/about");
  await waitForServiceWorkerControl(page);
  // Opening the section online fetches the lazy chunk through the service worker.
  await page.getByTestId("notices").locator("summary").click();
  await expect(page.getByTestId("notices-text")).toContainText("LGPL-3.0-or-later");

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Licences and source code" })).toBeVisible();
  await page.getByTestId("notices").locator("summary").click();
  await expect(page.getByTestId("notices-text")).toContainText("GNU LESSER GENERAL PUBLIC LICENSE");
});
