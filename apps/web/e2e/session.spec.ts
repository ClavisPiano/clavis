import { expect, test, type Page } from "@playwright/test";
import { runToSummary, storedEventTypes } from "./session-helpers";

/*
 * Full sessions with fake input and a silent instrument (?input=fake implies ?audio=silent).
 * The page exposes window.__clavisSession (what the current item expects) and
 * window.__clavisFakeInput (to play it), so each item is answered correctly.
 */

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

test.describe("session runner", () => {
  test.setTimeout(150_000);

  test("instrument mode: a whole session with fake input, then the event log", async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto("/session?input=fake&budget=90");
    await expect(page.getByTestId("start")).toBeVisible();
    await page.getByTestId("start").click();
    await expect(page.getByTestId("orient")).toBeVisible();
    await expect(page.getByTestId("key")).toContainText("C major");

    const answered = await runToSummary(page);
    // Degree items are sung and then played at the instrument.
    expect(answered).toContain("listening-sing");
    expect(answered).toContain("listening-play");

    await expect(page.getByTestId("summary")).toBeVisible();
    await expect(page.getByTestId("summary-items")).toHaveText("3");
    await expect(page.getByTestId("summary-accuracy")).toHaveText("100%");
    await expect(page.getByTestId("node-changes")).toContainText("Degrees 1, 3, 5");

    const types = await storedEventTypes(page);
    const first = types.indexOf("session.started");
    expect(first).toBeGreaterThan(-1);
    expect(types.slice(first)).toEqual([
      "session.started",
      "node.introduced",
      "item.presented",
      "attempt.completed",
      "item.presented",
      "attempt.completed",
      "item.presented",
      "attempt.completed",
      "session.ended",
    ]);
    expect(errors).toEqual([]);
  });

  test("Away mode: no orient block, sung and tapped answers", async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto("/session?mode=away&input=fake&budget=60");
    await page.getByTestId("start").click();
    // Away goes straight to the intro card for the new skill: there is no orient block.
    await expect(page.getByTestId("intro")).toBeVisible();
    await expect(page.getByTestId("orient")).toHaveCount(0);

    await runToSummary(page);
    await expect(page.getByTestId("summary-accuracy")).toHaveText("100%");

    const types = await storedEventTypes(page);
    const first = types.indexOf("session.started");
    const session = types.slice(first);
    expect(session[0]).toBe("session.started");
    expect(session.at(-1)).toBe("session.ended");
    expect(session.filter((t) => t === "attempt.completed").length).toBeGreaterThan(0);
    expect(session.filter((t) => t === "item.presented")).toHaveLength(
      session.filter((t) => t === "attempt.completed").length,
    );
    expect(errors).toEqual([]);
  });

  test("the headphones prompt appears once, then the answer is stored as a setting", async ({
    page,
  }) => {
    await page.goto("/session?input=fake&budget=60&headphones=ask");
    await page.getByTestId("start").click();
    await expect(page.getByRole("heading", { name: "Using headphones?" })).toBeVisible();
    // Nothing has started yet: no Finish to tap during the prompt.
    await expect(page.getByTestId("finish")).toHaveCount(0);
    await page.getByTestId("headphones-yes").click();
    await expect(page.getByTestId("orient")).toBeVisible();
    await page.getByTestId("finish").click();
    await page.getByTestId("finish-end").click();
    await expect(page.getByTestId("summary")).toBeVisible();
    const types = await storedEventTypes(page);
    expect(types).toContain("settings.changed");
  });

  test("Finish asks first: Keep going resumes, End session ends", async ({ page }) => {
    await page.goto("/session?input=fake&budget=90");
    await page.getByTestId("start").click();
    await expect(page.getByTestId("orient")).toBeVisible();
    await page.getByTestId("finish").click();
    await expect(page.getByTestId("finish-confirm")).toBeVisible();
    await expect(page.getByTestId("finish")).toHaveCount(0);
    await page.getByTestId("finish-cancel").click();
    await expect(page.getByTestId("orient")).toBeVisible();
    await page.getByTestId("finish").click();
    await page.getByTestId("finish-end").click();
    await expect(page.getByTestId("summary")).toBeVisible();
    // Keep going did not end the session: exactly one end was written.
    const ended = (await storedEventTypes(page)).filter((t) => t === "session.ended");
    expect(ended).toHaveLength(1);
  });

  test("the test hook is only exposed with fake input", async ({ page }) => {
    await page.goto("/session?audio=silent&input=tap");
    await expect(page.getByTestId("start")).toBeVisible();
    expect(await page.evaluate(() => window.__clavisSession)).toBeUndefined();
    expect(await page.evaluate(() => window.__clavisFakeInput)).toBeUndefined();
  });
});
