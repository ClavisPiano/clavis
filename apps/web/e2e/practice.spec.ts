import { expect, test, type Page } from "@playwright/test";
import { runToSummary } from "./session-helpers";

/* T2.15: "Practise more" after the day's session, and the new-items-per-day setting. */

const settingsV2Events = (page: Page) =>
  page.locator('[data-testid="event"][data-v="2"]').filter({ hasText: "settings.changed" });

test.describe("practise more", () => {
  test.setTimeout(240_000);

  test("is hidden on a fresh profile, then offered after a session and logs a practice session", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("start-session")).toBeVisible();
    await expect(page.getByTestId("keep-going")).toHaveCount(0);

    await page.goto("/session?input=fake&budget=90");
    await page.getByTestId("start").click();
    await runToSummary(page);
    await expect(page.getByTestId("summary")).toBeVisible();

    await page.getByTestId("home").click();
    await expect(page.getByTestId("today-status")).toContainText("Session done today");
    const link = page.getByTestId("keep-going");
    await expect(link).toBeVisible();
    await expect(link).toContainText("Keep going");
    await expect(link).toHaveAttribute("href", /\/session\?practice=1$/);

    await page.goto("/session?practice=1&input=fake&budget=90");
    await expect(page.getByTestId("session-intro")).toHaveText(
      "Extra practice on skills you have started. This does not change your review schedule.",
    );
    await page.getByTestId("start").click();
    await runToSummary(page);
    await expect(page.getByTestId("summary")).toBeVisible();
    const items = Number(await page.getByTestId("summary-items").textContent());
    expect(items).toBeGreaterThanOrEqual(1);
    // Nothing new is introduced in a practice session.
    await expect(page.getByTestId("node-changes")).toHaveCount(0);

    await page.goto("/dev/events");
    await expect(page.getByTestId("events")).toBeVisible();
    const started = page.locator('[data-testid="event"]').filter({ hasText: "session.started" });
    await expect(started).toHaveCount(2);
    // Newest first: the practice session, then the regular one.
    await expect(started.nth(0)).toHaveAttribute("data-practice", "true");
    await expect(started.nth(0)).toHaveAttribute("data-v", "2");
    await expect(started.nth(1)).toHaveAttribute("data-practice", "false");
    await expect(
      page.locator('[data-testid="event"]').filter({ hasText: "node.introduced" }),
    ).toHaveCount(1);
  });
});

test.describe("choose what to practise", () => {
  test.setTimeout(240_000);

  test("lists started skills, and the chosen one is all that is drilled", async ({ page }) => {
    await page.goto("/practice");
    await expect(page.getByTestId("practice-empty")).toBeVisible();

    await page.goto("/session?input=fake&budget=90");
    await page.getByTestId("start").click();
    await runToSummary(page);
    await page.getByTestId("home").click();

    await page.getByTestId("choose-practice").click();
    const skills = page.getByTestId("practice-skill");
    await expect(skills.first()).toBeVisible();
    const skill = skills.first();
    const node = await skill.getAttribute("data-node");
    await skill.check();
    await expect(page.getByTestId("practice-start")).toContainText("1 selected");
    await expect(page.getByTestId("practice-start")).toHaveAttribute(
      "href",
      new RegExp(`practice=1&skills=${encodeURIComponent(node ?? "")}`),
    );
  });
});

test.describe("new items per day", () => {
  test("persists across reload as a settings.changed v2 event", async ({ page }) => {
    await page.goto("/settings");
    const input = page.getByTestId("new-items-per-day");
    await expect(input).toHaveValue("5");
    await expect(page.getByText("More new items means faster progress")).toBeVisible();

    await input.fill("9");
    await input.blur();
    await page.getByTestId("save").click();
    await expect(page.getByTestId("saved")).toHaveText("Saved");

    await page.reload();
    await expect(page.getByTestId("new-items-per-day")).toHaveValue("9");

    await page.goto("/dev/events");
    await expect(page.getByTestId("events")).toBeVisible();
    await expect(settingsV2Events(page)).toHaveCount(1);
  });

  test("out-of-range values are clamped to 3..15", async ({ page }) => {
    await page.goto("/settings");
    const input = page.getByTestId("new-items-per-day");
    await input.fill("40");
    await input.blur();
    await expect(input).toHaveValue("15");
    await input.fill("1");
    await input.blur();
    await expect(input).toHaveValue("3");
  });
});
