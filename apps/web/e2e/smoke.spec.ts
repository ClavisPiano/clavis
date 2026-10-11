import { expect, test, type Page } from "@playwright/test";

// Fail on any console error or uncaught page error. There is no allowlist: add an entry here, with
// a reason, only if a browser emits an error we cannot avoid.
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

test("app loads and bottom nav navigates Home -> Settings -> Home", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Clavis" })).toBeVisible();

  const nav = page.getByRole("navigation", { name: "Primary" });
  await nav.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  await nav.getByRole("link", { name: "Home" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Clavis" })).toBeVisible();

  expect(errors).toEqual([]);
});

test("registers exactly one device.registered event, idempotent across reloads", async ({
  page,
}) => {
  const errors = collectErrors(page);

  await page.goto("/dev/events");
  await expect(page.getByTestId("device-id")).toBeVisible();
  await expect(page.getByTestId("event")).toHaveCount(1);
  await expect(page.getByTestId("event").first()).toContainText("device.registered");
  const deviceId = (await page.getByTestId("device-id").textContent()) ?? "";
  expect(deviceId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);

  await page.reload();
  await expect(page.getByTestId("device-id")).toHaveText(deviceId);
  await expect(page.getByTestId("event")).toHaveCount(1);
  await expect(page.getByTestId("event").first()).toContainText("device.registered");

  expect(errors).toEqual([]);
});

test("/dev index links to the event log", async ({ page }) => {
  await page.goto("/dev");
  await page.getByRole("link", { name: "Event log" }).click();
  await expect(page.getByRole("heading", { name: "Events" })).toBeVisible();
});
