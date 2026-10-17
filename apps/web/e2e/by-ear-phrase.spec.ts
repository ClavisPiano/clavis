import { expect, test, type Page } from "@playwright/test";
import { seedLearner } from "./read-helpers";
import { answerCurrentPhase, runToSummary } from "./session-helpers";

/*
 * By-ear melodies (BYEAR, T7.2): `byear.melody.simple` is offered in the Apply block once
 * `ear.cells.major.2-4` is mastered. The learner hears the key-setting cadence and a melody with no
 * notation, is cued to sing or hum it (ungraded, R29), plays it, and then the score is revealed.
 * Fake input answers through the session hook, as in the pieces spec.
 *
 * The seeded learner already has an ear node and a reading node mid-learning, so the session
 * introduces the by-ear node (strands take turns) and the other items come first, in a seeded order.
 */

const READY = ["ear.degrees.major.135", "ear.degrees.major.diatonic", "ear.cells.major.2-4"];

async function seedByEarLearner(page: Page, placedMastered: readonly string[] = READY) {
  await seedLearner(
    page,
    [{ nodeId: "ear.rhythm.echo" }, { nodeId: "read.bass.landmarks", keyFamily: "A" }],
    { placedMastered },
  );
}

/** How many stored events match a CSS filter, read from the event log page of a second tab. */
async function countEvents(page: Page, filter: string): Promise<number> {
  const log = await page.context().newPage();
  try {
    await log.goto("/dev/events");
    await expect(log.getByTestId("events")).toBeVisible();
    return await log.locator(`[data-testid="event"]${filter}`).count();
  } finally {
    await log.close();
  }
}

/**
 * Answer items until the by-ear melody reaches its sing or hum cue (the other items of the session
 * come in a seeded order). Leaves the session at the cue.
 */
async function untilCue(page: Page): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const state = await page.getByTestId("session").getAttribute("data-state");
    const phase = await page.evaluate(() => window.__clavisSession?.phase ?? "");
    if (state === "listening" && phase === "listening-cue") return;
    if (state === "listening" && phase === "listening-practice") {
      await page
        .getByTestId("ready")
        .click({ timeout: 2_000 })
        .catch(() => undefined);
    } else if (state === "listening" && phase === "listening-play") {
      await answerCurrentPhase(page);
      await page.waitForFunction((before) => window.__clavisSession?.phase !== before, phase, {
        timeout: 20_000,
      });
    } else if (state === "orient" || state === "intro") {
      await page
        .getByTestId("continue")
        .click({ timeout: 2_000 })
        .catch(() => undefined);
    } else if (state === "feedback") {
      await page
        .getByTestId("next")
        .click({ timeout: 2_000 })
        .catch(() => undefined);
    } else if (state === "summary" || state === "error") {
      throw new Error("the session ended before the by-ear melody");
    } else {
      await page.waitForTimeout(100);
    }
  }
  throw new Error("the by-ear melody never reached its cue");
}

test.describe("By-ear melody", () => {
  test.setTimeout(180_000);
  const url = "/session?input=fake&audio=silent&budget=420";

  test("goes hear, cue, play, reveal: the cue is shown, grades nothing, and the score appears after playing", async ({
    page,
  }) => {
    await seedByEarLearner(page);
    await page.goto(url);
    await page.getByTestId("start").click();
    await untilCue(page);

    // Cue: the learner is asked to sing or hum, nothing is expected from the voice, and no music
    // is shown. There is no Done button and no keyboard: only Ready moves on.
    const sung = await page.evaluate(() => window.__clavisSession?.expected?.sing);
    expect(sung).toBeUndefined();
    await expect(page.getByTestId("prompt")).toHaveText("Sing or hum it, out loud or in your head");
    await expect(page.getByTestId("cue-help")).toBeVisible();
    await expect(page.getByTestId("hear-again")).toBeVisible();
    await expect(page.getByTestId("notation-slot")).toHaveCount(0);
    await expect(page.getByTestId("done")).toHaveCount(0);
    await expect(page.getByTestId("live-keyboard")).toHaveCount(0);

    // Nothing is timed: the cue waits, and Ready continues without any microphone input.
    await page.waitForTimeout(1_500);
    await expect(page.getByTestId("prompt")).toHaveText("Sing or hum it, out loud or in your head");
    await page.getByTestId("ready").click();

    // Play: still no music.
    await page.waitForFunction(() => window.__clavisSession?.phase === "listening-play");
    await expect(page.getByTestId("prompt")).toHaveText("Play it");
    await expect(page.getByTestId("notation-slot")).toHaveCount(0);
    await answerCurrentPhase(page);

    // Reveal: the played line was right, so the score is drawn and stays until the learner moves on.
    await expect(page.getByTestId("result")).toHaveText("Correct", { timeout: 40_000 });
    await expect(page.getByTestId("notation-slot")).toBeVisible();
    await expect(page.getByTestId("next")).toBeVisible();
    expect(await countEvents(page, `[data-generator="byEarPhrase"][data-block="apply"]`)).toBe(1);
  });

  test("a wrong played note reads Not quite and says you played, never sang", async ({ page }) => {
    await seedByEarLearner(page);
    await page.goto(url);
    await page.getByTestId("start").click();
    await untilCue(page);

    await page.getByTestId("ready").click();
    await page.waitForFunction(() => window.__clavisSession?.phase === "listening-play");
    await answerCurrentPhase(page, { wrongAt: 2 });

    await expect(page.getByTestId("result")).toHaveText("Not quite", { timeout: 40_000 });
    await expect(page.getByTestId("issues")).toContainText("you played");
    await expect(page.getByTestId("issues")).not.toContainText(/sang|sung/i);
    // The score is still revealed, so the learner can see what was written.
    await expect(page.getByTestId("notation-slot")).toBeVisible();
  });

  test("nothing is offered by ear until ear.cells.major.2-4 is mastered", async ({ page }) => {
    await seedByEarLearner(
      page,
      READY.filter((id) => id !== "ear.cells.major.2-4"),
    );
    await page.goto(url);
    await page.getByTestId("start").click();
    const phases = await runToSummary(page);
    expect(phases.every((p) => p === "listening-play")).toBe(true);
    expect(await countEvents(page, `[data-generator="byEarPhrase"]`)).toBe(0);
  });
});
