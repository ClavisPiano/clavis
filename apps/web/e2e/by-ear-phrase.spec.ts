import { expect, test, type Page } from "@playwright/test";
import { seedLearner } from "./read-helpers";
import { answerCurrentPhase, runToSummary, singCurrentPhase } from "./session-helpers";

/*
 * By-ear melodies (BYEAR, T7.2): `byear.melody.simple` is offered in the Apply block once
 * `ear.cells.major.2-4` is mastered. The learner hears the key-setting cadence and a melody with no
 * notation, sings it, plays it, and then the score is revealed. Fake input answers through the
 * session hook, as in the pieces spec.
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
 * Answer items until the by-ear melody asks for singing (the other items of the session come in a
 * seeded order). Leaves the session in that sung phase.
 */
async function untilSingingPhase(page: Page): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const state = await page.getByTestId("session").getAttribute("data-state");
    const phase = await page.evaluate(() => window.__clavisSession?.phase ?? "");
    if (state === "listening" && phase === "listening-sing") return;
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
  throw new Error("the by-ear melody never asked for singing");
}

test.describe("By-ear melody", () => {
  test.setTimeout(180_000);
  const url = "/session?input=fake&audio=silent&budget=420";

  test("goes hear, sing, play, reveal: the score appears only after both parts", async ({
    page,
  }) => {
    await seedByEarLearner(page);
    await page.goto(url);
    await page.getByTestId("start").click();
    await untilSingingPhase(page);

    // Hear: it is a sung sequence of the melody, and no music is shown while singing.
    const kind = await page.evaluate(() => window.__clavisSession?.expected?.sing?.kind);
    expect(kind).toBe("sungSequence");
    await expect(page.getByTestId("prompt")).toHaveText("Sing it");
    await expect(page.getByTestId("notation-slot")).toHaveCount(0);
    await singCurrentPhase(page);

    // Play: still no music.
    await page.waitForFunction(() => window.__clavisSession?.phase === "listening-play");
    await expect(page.getByTestId("prompt")).toHaveText("Now play it");
    await expect(page.getByTestId("notation-slot")).toHaveCount(0);
    await answerCurrentPhase(page);

    // Reveal: both parts right, so the score is drawn and stays until the learner moves on.
    await expect(page.getByTestId("result")).toHaveText("Correct", { timeout: 40_000 });
    await expect(page.getByTestId("notation-slot")).toBeVisible();
    await expect(page.getByTestId("next")).toBeVisible();
    expect(await countEvents(page, `[data-generator="byEarPhrase"][data-block="apply"]`)).toBe(1);
  });

  test("a wrong sung note reads Not quite and says you sang, even when the playing is right", async ({
    page,
  }) => {
    await seedByEarLearner(page);
    await page.goto(url);
    await page.getByTestId("start").click();
    await untilSingingPhase(page);

    await singCurrentPhase(page, { wrongAt: 2 });
    await page.waitForFunction(() => window.__clavisSession?.phase === "listening-play");
    await answerCurrentPhase(page);

    await expect(page.getByTestId("result")).toHaveText("Not quite", { timeout: 40_000 });
    await expect(page.getByTestId("issues")).toContainText("you sang");
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
    expect(phases).not.toContain("listening-sing");
    expect(await countEvents(page, `[data-generator="byEarPhrase"]`)).toBe(0);
  });
});
