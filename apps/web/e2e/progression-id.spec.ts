import { expect, test, type Page } from "@playwright/test";
import { seedLearner } from "./read-helpers";
import { runToSummary } from "./session-helpers";

/*
 * Progression ear (T7.1, R21): hear a chord progression after the cadence and pick it by name with
 * buttons, in both modes. The learner has `ear.prog.core` introduced and everything before it
 * placed, so the session is progressionId items. Fake input lets the spec read the right answer
 * from the session hook.
 */

async function seedProgressionLearner(page: Page): Promise<void> {
  await seedLearner(page, [{ nodeId: "ear.prog.core" }], {
    placedMastered: [
      "ear.degrees.major.135",
      "ear.degrees.major.diatonic",
      "ear.bass.I-IV-V-vi",
      "ear.quality.triad",
    ],
  });
}

interface Heard {
  correct: string;
  labels: string[];
}

/** Click through intro cards and the orient block until a choice item awaits an answer. */
async function toChoiceItem(page: Page): Promise<Heard> {
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
      const heard = await page.evaluate(() => {
        const play = window.__clavisSession?.expected?.play;
        return play?.kind === "choice"
          ? { correct: play.correct, labels: play.options.map((o) => o.label) }
          : undefined;
      });
      if (heard) return heard;
      throw new Error("the first item is not a choice item");
    } else await page.waitForTimeout(100);
  }
  throw new Error("no choice item appeared");
}

const CORE = ["I-V-vi-IV", "I-IV-V", "ii-V-I", "vi-IV-I-V"];

for (const mode of ["away", "instrument"] as const) {
  test.describe(`Progression ear in ${mode} mode`, () => {
    test.setTimeout(90_000);
    const url = `/session?mode=${mode}&input=fake&budget=120`;

    test("shows a button for each core progression and no keyboard or Done", async ({ page }) => {
      await seedProgressionLearner(page);
      await page.goto(url);
      await page.getByTestId("start").click();
      const heard = await toChoiceItem(page);
      expect(heard.labels).toEqual(CORE);
      await expect(page.getByTestId("prompt")).toHaveText("Which one did you hear?");
      for (const label of CORE) {
        await expect(page.getByTestId(`choice-${label}`)).toHaveText(label);
      }
      await expect(page.getByTestId("done")).toHaveCount(0);
      await expect(page.locator("[data-midi]")).toHaveCount(0);
    });

    test("the right button passes", async ({ page }) => {
      await seedProgressionLearner(page);
      await page.goto(url);
      await page.getByTestId("start").click();
      const { correct } = await toChoiceItem(page);
      await page.getByTestId(`choice-${correct}`).click();
      await expect(page.getByTestId("feedback")).toHaveAttribute("data-correct", "true");
      await expect(page.getByTestId("result")).toHaveText("Correct");
    });

    test("the wrong button fails and names the heard and chosen progression", async ({ page }) => {
      await seedProgressionLearner(page);
      await page.goto(url);
      await page.getByTestId("start").click();
      const { correct } = await toChoiceItem(page);
      const wrong = CORE.find((l) => l !== correct) ?? "";
      await page.getByTestId(`choice-${wrong}`).click();
      await expect(page.getByTestId("feedback")).toHaveAttribute("data-correct", "false");
      await expect(page.getByTestId("issues")).toContainText(
        `You chose ${wrong}; it was ${correct}`,
      );
    });
  });
}

test("a whole session of progression items runs to the summary", async ({ page }) => {
  test.setTimeout(120_000);
  await seedProgressionLearner(page);
  await page.goto("/session?mode=instrument&input=fake&budget=60");
  await page.getByTestId("start").click();
  const answered = await runToSummary(page);
  expect(answered.length).toBeGreaterThan(0);
  expect(answered.every((p) => p === "listening-play")).toBe(true);
});
