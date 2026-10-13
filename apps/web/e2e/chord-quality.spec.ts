import { expect, test, type Page } from "@playwright/test";
import { seedLearner } from "./read-helpers";
import { runToSummary } from "./session-helpers";

/*
 * Triad quality (TP.1, R21): hear a chord after the cadence and pick major or minor with buttons,
 * in both modes. The learner has `ear.quality.triad` introduced and everything before it placed,
 * so the session is chordQuality items. Fake input lets the spec read the right answer from the
 * session hook.
 */

async function seedTriadLearner(page: Page): Promise<void> {
  await seedLearner(page, [{ nodeId: "ear.quality.triad" }], {
    placedMastered: ["ear.degrees.major.135", "ear.degrees.major.diatonic", "ear.bass.I-IV-V-vi"],
  });
}

/** Click through intro cards and the orient block until a choice item awaits an answer. */
async function toChoiceItem(page: Page): Promise<string> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const state = await page.getByTestId("session").getAttribute("data-state");
    if (state === "error" || state === "summary") throw new Error(`session ended early: ${state}`);
    if (state === "orient" || state === "intro") {
      await page
        .getByTestId("continue")
        .click({ timeout: 1_000 })
        .catch(() => undefined);
    } else if (state === "listening") {
      const correct = await page.evaluate(() => {
        const play = window.__clavisSession?.expected?.play;
        return play?.kind === "choice" ? play.correct : undefined;
      });
      if (correct) return correct;
      throw new Error("the first item is not a choice item");
    } else await page.waitForTimeout(100);
  }
  throw new Error("no choice item appeared");
}

const WRONG: Record<string, string> = { major: "minor", minor: "major" };

for (const mode of ["away", "instrument"] as const) {
  test.describe(`Triad quality in ${mode} mode`, () => {
    test.setTimeout(90_000);
    const url = `/session?mode=${mode}&input=fake&budget=120`;

    test("shows Major and Minor buttons and no keyboard or Done", async ({ page }) => {
      await seedTriadLearner(page);
      await page.goto(url);
      await page.getByTestId("start").click();
      await toChoiceItem(page);
      await expect(page.getByTestId("prompt")).toHaveText("Major or minor?");
      await expect(page.getByTestId("choice-major")).toHaveText("Major");
      await expect(page.getByTestId("choice-minor")).toHaveText("Minor");
      await expect(page.getByTestId("done")).toHaveCount(0);
      await expect(page.locator("[data-midi]")).toHaveCount(0);
    });

    test("the right button passes", async ({ page }) => {
      await seedTriadLearner(page);
      await page.goto(url);
      await page.getByTestId("start").click();
      const correct = await toChoiceItem(page);
      await page.getByTestId(`choice-${correct}`).click();
      await expect(page.getByTestId("feedback")).toHaveAttribute("data-correct", "true");
      await expect(page.getByTestId("result")).toHaveText("Correct");
    });

    test("the wrong button fails and says what was chosen", async ({ page }) => {
      await seedTriadLearner(page);
      await page.goto(url);
      await page.getByTestId("start").click();
      const correct = await toChoiceItem(page);
      const wrong = WRONG[correct] ?? "minor";
      await page.getByTestId(`choice-${wrong}`).click();
      await expect(page.getByTestId("feedback")).toHaveAttribute("data-correct", "false");
      await expect(page.getByTestId("issues")).toContainText(
        `You chose ${wrong}; it was ${correct}`,
      );
    });
  });
}

test("a whole session of choice items runs to the summary", async ({ page }) => {
  test.setTimeout(120_000);
  await seedTriadLearner(page);
  await page.goto("/session?mode=instrument&input=fake&budget=60");
  await page.getByTestId("start").click();
  const answered = await runToSummary(page);
  expect(answered.length).toBeGreaterThan(0);
  expect(answered.every((p) => p === "listening-play")).toBe(true);
});
