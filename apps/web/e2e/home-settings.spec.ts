import { expect, test, type Page } from "@playwright/test";

// Fixed timezone so the seeded learner day matches the one the page computes.
test.use({ timezoneId: "UTC" });

async function eventTypes(page: Page): Promise<string[]> {
  await page.goto("/dev/events");
  await expect(page.getByTestId("events")).toBeVisible();
  return page.getByTestId("event").locator("strong").allTextContents();
}

test("fresh profile shows the welcome, estimated length and no history", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("welcome")).toBeVisible();
  await expect(page.getByTestId("start-session")).toContainText("12 min");
  await expect(page.getByTestId("start-away")).toContainText("5 min, no piano needed");
  await expect(page.getByTestId("start-session")).toHaveAttribute("href", /\/session$/);
  await expect(page.getByTestId("start-away")).toHaveAttribute("href", /\/session\?mode=away$/);
  await expect(page.getByTestId("days")).toHaveCount(0);
});

test("settings persist across reload as a settings.changed event", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByTestId("budget")).toHaveValue("12");

  await page.getByTestId("budget").selectOption("20");
  await page.getByTestId("headphones-yes").check();
  await page.getByTestId("input-mode").selectOption("tap");
  await page.getByTestId("save").click();
  await expect(page.getByTestId("saved")).toHaveText("Saved");

  await page.reload();
  await expect(page.getByTestId("budget")).toHaveValue("20");
  await expect(page.getByTestId("headphones-yes")).toBeChecked();
  await expect(page.getByTestId("input-mode")).toHaveValue("tap");

  expect(await eventTypes(page)).toContain("settings.changed");

  await page.goto("/");
  await expect(page.getByTestId("start-session")).toContainText("20 min");
});

test("auto-continue defaults to 3 seconds and the choice persists", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByTestId("auto-continue")).toHaveValue("3");
  await page.getByTestId("auto-continue").selectOption("0");
  await page.getByTestId("save").click();
  await expect(page.getByTestId("saved")).toHaveText("Saved");
  await page.reload();
  await expect(page.getByTestId("auto-continue")).toHaveValue("0");
});

test("about shows which build is running", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByTestId("build-id")).toHaveText(
    /^([0-9a-f]{7}|dev) \(\d{4}-\d{2}-\d{2}\)$/,
  );
});

test("there is no voice range control: singing is not graded (R29)", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByTestId("budget")).toBeVisible();
  await expect(page.getByTestId("range-preset")).toHaveCount(0);
  await expect(page.getByTestId("range-low")).toHaveCount(0);
  await expect(page.getByTestId("range-high")).toHaveCount(0);
  await expect(page.getByText("Voice range")).toHaveCount(0);
  await expect(page.getByTestId("save")).toBeEnabled();
});

test("settings links to latency, backup and shows versions", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByRole("link", { name: "Latency calibration" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Backup and restore/ })).toHaveAttribute(
    "href",
    /\/dev\/state$/,
  );
  await expect(page.getByTestId("app-version")).not.toBeEmpty();
  await expect(page.getByTestId("content-version")).not.toBeEmpty();
});

test("home shows the 7-day row after a seeded session", async ({ page }) => {
  // Pin the page clock to midday UTC so the seeded session never straddles the 04:00 rollover.
  const now = Date.parse("2026-10-14T12:00:00Z");
  await page.clock.setFixedTime(now);
  const doc = {
    format: "clavis-events",
    formatVersion: 1,
    exportedAt: new Date(now).toISOString(),
    deviceId: "seed-device",
    contentVersion: "seed",
    reducerVersion: 1,
    events: [
      {
        id: "01JBX00000000000000000S001",
        deviceId: "seed-device",
        at: now - 4 * 60_000,
        type: "session.started",
        v: 1,
        sessionId: "01JBX00000000000000000S002",
        mode: "instrument",
        budgetSec: 720,
        key: { tonic: "C", mode: "major" },
        tzOffsetMin: 0,
        contentVersion: "seed",
      },
      {
        id: "01JBX00000000000000000S003",
        deviceId: "seed-device",
        at: now - 60_000,
        type: "session.ended",
        v: 1,
        sessionId: "01JBX00000000000000000S002",
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
  await expect(page.getByTestId("import-status")).toContainText("2 valid events");
  await page.getByTestId("import").click();
  await expect(page.getByTestId("import-status")).toContainText("2 inserted");

  await page.goto("/");
  await expect(page.getByTestId("day-cell")).toHaveCount(7);
  await expect(page.getByTestId("welcome")).toHaveCount(0);
  await expect(page.getByTestId("today-status")).toContainText("Session done today");
  await expect(page.getByTestId("week-progress")).toContainText("This week: 1 of 5 days");
  await expect(page.getByTestId("day-cell").last()).toHaveAttribute("data-level", "1");
});

test("the keyboard page marks the home note and chord and can be played any time", async ({
  page,
}) => {
  await page.goto("/keyboard");
  await expect(page.getByTestId("keyboard-key")).toBeVisible();
  await page.getByTestId("keyboard-key").selectOption({ label: "G major" });
  const board = page.getByTestId("keyboard-board");
  await expect(board.locator('[data-mark="tonic"]').first()).toBeVisible();
  await expect(board.locator('[data-mark="chord"]').first()).toBeVisible();
  // G, B and D are marked; C is not.
  await expect(board.locator('[data-midi="67"]')).toHaveAttribute("data-mark", "tonic");
  await expect(board.locator('[data-midi="71"]')).toHaveAttribute("data-mark", "chord");
  await expect(board.locator('[data-midi="60"]')).not.toHaveAttribute("data-mark", /.+/);
  await board.locator('[data-midi="67"]').click();
  await expect(page.getByTestId("hear-key")).toBeVisible();
});
