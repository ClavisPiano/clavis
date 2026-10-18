import { expect, test } from "@playwright/test";
import { runToSummary } from "./session-helpers";

/* R30: after several missed days Home offers a shorter session that only reviews. */

const DAY = 86_400_000;

test.describe("welcome back", () => {
  test.setTimeout(240_000);

  test("a new learner is not welcomed back", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("start-session")).toBeVisible();
    await expect(page.getByTestId("welcome-back")).toHaveCount(0);
    await expect(page.getByTestId("welcome-back-start")).toHaveCount(0);
  });

  test("after a long break Home offers a short review, which starts a nothing-new session", async ({
    page,
  }) => {
    await page.goto("/session?input=fake&budget=90");
    await page.getByTestId("start").click();
    await runToSummary(page);
    await expect(page.getByTestId("summary")).toBeVisible();

    // The next day there is nothing to welcome anyone back from.
    await page.clock.setFixedTime(Date.now() + DAY);
    await page.goto("/");
    await expect(page.getByTestId("start-session")).toBeVisible();
    await expect(page.getByTestId("welcome-back")).toHaveCount(0);

    // Twelve days on, the cards are due and the learner has been away.
    await page.clock.setFixedTime(Date.now() + 12 * DAY);
    await page.goto("/");
    await expect(page.getByTestId("welcome-back")).toContainText(/1[23] days ago/);
    const start = page.getByTestId("welcome-back-start");
    await expect(start).toBeVisible();
    await expect(start).toContainText("nothing new");
    await expect(start).toHaveAttribute("href", /welcome=1/);
    // The usual session is still there, just not the main button.
    await expect(page.getByTestId("start-session")).toHaveClass(/secondary/);

    await start.click();
    await expect(page).toHaveURL(/welcome=1/);
    await expect(page.getByRole("heading", { name: "Welcome back", level: 1 })).toBeVisible();
    await expect(page.getByTestId("session-intro")).toContainText("Nothing new today");
  });
});
