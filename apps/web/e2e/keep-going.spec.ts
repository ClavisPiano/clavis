import { expect, test } from "@playwright/test";
import { runToSummary } from "./session-helpers";

/* Keep going: after a short session the summary offers more, instead of only returning home. */

test.describe("keep going", () => {
  test.setTimeout(240_000);

  test("a short session offers Keep going and Learn something new, and Keep going starts practice", async ({
    page,
  }) => {
    await page.goto("/session?input=fake&budget=90");
    await page.getByTestId("start").click();
    await runToSummary(page);
    await expect(page.getByTestId("summary")).toBeVisible();

    const keep = page.getByTestId("keep-going");
    const learn = page.getByTestId("learn-more");
    await expect(keep).toBeVisible();
    await expect(learn).toBeVisible();
    await expect(page.getByTestId("home")).toHaveText("Done for today");
    await expect(keep).toHaveAttribute("href", /practice=1/);
    await expect(keep).toHaveAttribute("href", /input=fake/);
    await expect(learn).toHaveAttribute("href", /learn=1/);

    await keep.click();
    await expect(page.getByTestId("session-intro")).toContainText("Extra practice");
    await page.getByTestId("start").click();
    await runToSummary(page);
    await expect(page.getByTestId("summary")).toBeVisible();
    expect(Number(await page.getByTestId("summary-items").textContent())).toBeGreaterThanOrEqual(1);
    await expect(page.getByTestId("node-changes")).toHaveCount(0);

    await page.goto("/dev/events");
    await expect(page.getByTestId("events")).toBeVisible();
    const started = page.locator('[data-testid="event"]').filter({ hasText: "session.started" });
    await expect(started).toHaveCount(2);
    await expect(started.nth(0)).toHaveAttribute("data-practice", "true");
  });

  test("Learn something new starts a session that is not a practice round", async ({ page }) => {
    await page.goto("/session?input=fake&budget=90");
    await page.getByTestId("start").click();
    await runToSummary(page);
    await page.getByTestId("learn-more").click();
    await expect(page.getByTestId("session-intro")).toContainText("new material");
    await page.getByTestId("start").click();
    await runToSummary(page);
    await expect(page.getByTestId("summary")).toBeVisible();

    await page.goto("/dev/events");
    await expect(page.getByTestId("events")).toBeVisible();
    const started = page.locator('[data-testid="event"]').filter({ hasText: "session.started" });
    await expect(started).toHaveCount(2);
    await expect(started.nth(0)).toHaveAttribute("data-practice", "false");
  });

  test("Home promotes Keep going once today's session is done", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("keep-going")).toHaveCount(0);
    await page.goto("/session?input=fake&budget=90");
    await page.getByTestId("start").click();
    await runToSummary(page);
    await page.getByTestId("home").click();
    await expect(page.getByTestId("today-status")).toContainText("Session done today");
    await expect(page.getByTestId("keep-going")).toBeVisible();
    await expect(page.getByTestId("learn-more")).toBeVisible();
    await expect(page.getByTestId("start-session")).toBeVisible();
  });
});
