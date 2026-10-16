import { expect, test, type Page } from "@playwright/test";

// Fixed timezone and clock so the seeded days match the ones the page computes.
// 2026-10-14 is a Wednesday, so this week (Monday start) is 10-12 to 10-18.
test.use({ timezoneId: "UTC" });
const NOW = Date.parse("2026-10-14T12:00:00Z");

const SEED_DEVICE = "seed-device";
let seq = 0;
const eid = (): string => `01JBX0000000000000000${String(++seq).padStart(5, "0")}`;

/** A finished session of `minutes` starting at `startMs`, with two answered items. */
function session(startMs: number, minutes: number, n: number) {
  const sessionId = `01JBX0000000000000SESS${String(n).padStart(4, "0")}`;
  const base = { deviceId: SEED_DEVICE };
  const attempt = (offsetMs: number, correct: boolean, latencyMs: number) => ({
    ...base,
    id: eid(),
    at: startMs + offsetMs,
    type: "attempt.completed",
    v: 1,
    sessionId,
    itemId: `ear.degrees.major.diatonic|d=${String(offsetMs)}`,
    nodeId: "ear.degrees.major.diatonic",
    outcome: { correct, latencyMs, retries: 0 },
    inputSource: "midi",
  });
  return [
    {
      ...base,
      id: eid(),
      at: startMs,
      type: "session.started",
      v: 1,
      sessionId,
      mode: "instrument",
      budgetSec: 720,
      key: { tonic: "C", mode: "major" },
      tzOffsetMin: 0,
      contentVersion: "seed",
    },
    attempt(60_000, true, 1800),
    attempt(90_000, false, 3000),
    {
      ...base,
      id: eid(),
      at: startMs + minutes * 60_000,
      type: "session.ended",
      v: 1,
      sessionId,
      reason: "completed",
    },
  ];
}

async function seed(page: Page): Promise<void> {
  const morning = (d: string): number => Date.parse(`${d}T10:00:00Z`);
  const events = [
    ...session(morning("2026-10-14"), 6, 1), // today
    ...session(morning("2026-10-13"), 12, 2),
    ...session(morning("2026-10-12"), 3, 3),
    ...session(morning("2026-10-06"), 8, 4), // last week
    ...session(morning("2026-09-01"), 4, 5), // weeks ago
  ];
  const doc = {
    format: "clavis-events",
    formatVersion: 1,
    exportedAt: new Date(NOW).toISOString(),
    deviceId: SEED_DEVICE,
    contentVersion: "seed",
    reducerVersion: 1,
    events,
  };
  const count = String(events.length);
  await page.goto("/dev/state");
  await expect(page.getByTestId("event-count")).toHaveText("1");
  await page.getByTestId("import-file").setInputFiles({
    name: "seed.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(doc)),
  });
  await expect(page.getByTestId("import-status")).toContainText(`${count} valid`);
  await page.getByTestId("import").click();
  await expect(page.getByTestId("import-status")).toContainText(`${count} inserted`);
}

test("a fresh learner sees an empty, neutral progress page", async ({ page }) => {
  await page.clock.setFixedTime(NOW);
  await page.goto("/progress");
  await expect(page.getByRole("heading", { name: "Progress" })).toBeVisible();
  await expect(page.getByTestId("weekly-target")).toHaveText("0 of 5 days this week");
  await expect(page.getByTestId("calendar-empty")).toBeVisible();
  await expect(page.getByTestId("calendar-cell")).toHaveCount(12 * 7);
  await expect(page.getByTestId("trends-empty")).toBeVisible();
  await expect(page.getByText(/streak/i)).toHaveCount(0);
});

test("a seeded learner sees practised days, the weekly target and trends", async ({ page }) => {
  await page.clock.setFixedTime(NOW);
  await seed(page);
  await page.goto("/progress");

  await expect(page.getByTestId("weekly-target")).toHaveText("3 of 5 days this week");
  await expect(page.getByTestId("week-bar")).toHaveCount(8);
  await expect(page.getByTestId("week-bar").last()).toHaveAttribute("data-days", "3");
  await expect(page.getByTestId("week-bar").nth(6)).toHaveAttribute("data-days", "1");

  const cells = page.getByTestId("calendar-cell");
  await expect(cells).toHaveCount(12 * 7);
  const day = (d: string) => page.locator(`[data-testid="calendar-cell"][data-day="${d}"]`);
  await expect(day("2026-10-14")).toHaveAttribute("data-level", "2");
  await expect(day("2026-10-14")).toHaveAttribute(
    "aria-label",
    /2026-10-14: 6 min practised, today/,
  );
  await expect(day("2026-10-13")).toHaveAttribute("data-level", "3");
  await expect(day("2026-10-12")).toHaveAttribute("data-level", "1");
  await expect(day("2026-10-06")).toHaveAttribute("data-minutes", "8");
  await expect(day("2026-10-11")).toHaveAttribute("data-level", "0");
  await expect(day("2026-10-11")).toHaveAttribute("aria-label", /no practice/);
  await expect(page.locator('[data-testid="calendar-cell"]:not([data-level="0"])')).toHaveCount(5);
  await expect(page.getByText(/streak/i)).toHaveCount(0);

  await expect(page.getByTestId("trend-row")).toHaveCount(1);
  await expect(page.getByTestId("trend-row")).toContainText("Ear");
  await expect(page.getByTestId("spark-accuracy")).toBeVisible();
  await expect(page.getByTestId("spark-latency")).toBeVisible();
});

test("changing the weekly target in settings persists and shows on progress", async ({ page }) => {
  await page.clock.setFixedTime(NOW);
  await seed(page);
  await page.goto("/settings");
  await expect(page.getByTestId("weekly-target")).toHaveValue("5");
  await page.getByTestId("weekly-target").selectOption("3");
  await page.getByTestId("save").click();
  await expect(page.getByTestId("saved")).toHaveText("Saved");

  await page.reload();
  await expect(page.getByTestId("weekly-target")).toHaveValue("3");

  await page.goto("/progress");
  await expect(page.getByTestId("weekly-target")).toHaveText("3 of 3 days this week");
  await expect(page.getByTestId("weekly-met")).toBeVisible();
});

test("home and the nav link to progress", async ({ page }) => {
  await page.clock.setFixedTime(NOW);
  await seed(page);
  await page.goto("/");
  await page.getByTestId("see-progress").click();
  await expect(page).toHaveURL(/\/progress$/);
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav.getByRole("link", { name: "Progress" })).toHaveAttribute("aria-current", "page");
});
