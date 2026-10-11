import { expect, test, type Page } from "@playwright/test";

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
  });
  page.on("pageerror", (err) => {
    errors.push(`pageerror: ${err.message}`);
  });
  return errors;
}

test("fake input: window hook emits a note that appears in the list", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/dev/input?input=fake");
  await expect(page.getByTestId("input-state")).toHaveText("fake: running");
  await page.waitForFunction(() => window.__clavisFakeInput !== undefined);

  await page.evaluate(() => window.__clavisFakeInput?.emitNote(60));
  await expect(page.getByTestId("note")).toHaveCount(1);
  await expect(page.getByTestId("note").first()).toContainText("midi 60");
  await expect(page.getByTestId("note").first()).toContainText("source=mic");

  await page.getByRole("button", { name: "Emit E4" }).click();
  await expect(page.getByTestId("note")).toHaveCount(2);
  await expect(page.getByTestId("note").first()).toContainText("midi 64");
  expect(errors).toEqual([]);
});

test("the fake hook is absent unless requested", async ({ page }) => {
  await page.goto("/dev/input?input=tap");
  await expect(page.getByTestId("input-state")).toHaveText("tap: stopped");
  expect(await page.evaluate(() => window.__clavisFakeInput)).toBeUndefined();
});

test("tap input: clicking a key adds a tap note", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/dev/input?input=tap");
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByTestId("input-state")).toHaveText("tap: running");

  await page.getByRole("button", { name: "C 4", exact: true }).click();
  await expect(page.getByTestId("note")).toHaveCount(1);
  await expect(page.getByTestId("note").first()).toContainText("midi 60");
  await expect(page.getByTestId("note").first()).toContainText("source=tap");

  await page.getByRole("button", { name: "G 4", exact: true }).click();
  await expect(page.getByTestId("note")).toHaveCount(2);
  await expect(page.getByTestId("note").first()).toContainText("midi 67");
  expect(errors).toEqual([]);
});

test("/dev index links to input adapters", async ({ page }) => {
  await page.goto("/dev");
  await page.getByRole("link", { name: "Input adapters" }).click();
  await expect(page.getByRole("heading", { name: "Input adapters" })).toBeVisible();
});
