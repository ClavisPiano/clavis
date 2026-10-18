import { expect, test, type Page } from "@playwright/test";

// T8.4: events are stamped with a corrected time when this device's clock is more than a day ahead
// of the server's. The skew is learned from sync responses; here it is planted directly.

const DAY = 86_400_000;

async function registeredAt(page: Page): Promise<number> {
  await page.goto("/dev/events");
  const row = page.getByTestId("event").filter({ hasText: "device.registered" });
  await expect(row).toBeVisible();
  const iso = await row.locator("time").getAttribute("datetime");
  return Date.parse(iso ?? "");
}

test("a device clock two days ahead of the server stamps events two days earlier", async ({
  page,
}) => {
  await page.addInitScript((skew) => {
    localStorage.setItem("clavis.clock-skew-ms", String(skew));
  }, -2 * DAY);
  const before = Date.now();
  const at = await registeredAt(page);
  expect(at).toBeLessThan(before - 2 * DAY + 5 * 60_000);
  expect(at).toBeGreaterThan(before - 2 * DAY - 5 * 60_000);
});

test("a small skew leaves events on the device clock", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("clavis.clock-skew-ms", String(-60_000));
  });
  const before = Date.now();
  const at = await registeredAt(page);
  expect(Math.abs(at - before)).toBeLessThan(5 * 60_000);
});
