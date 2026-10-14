import { expect, test, type Page } from "@playwright/test";
import { seedLearner } from "./read-helpers";

/*
 * Bass motion (TP.1) in an Away session: hear a progression, then give its four bass roots. The
 * learner has `ear.bass.I-IV-V-vi` introduced, so the session draws its items. Fake input lets the
 * spec read what the item expects from the session hook and answer it, because the mic cannot be
 * opened headless; the sung items that share the session are skipped. In Away mode the only item
 * with a pitch-class sequence to play and nothing to sing is bassMotion.
 */

const SESSION_URL = "/session?mode=away&input=fake&budget=120";

async function seedBassLearner(page: Page): Promise<void> {
  await seedLearner(page, [{ nodeId: "ear.bass.I-IV-V-vi" }], {
    placedMastered: ["ear.degrees.major.135", "ear.degrees.major.diatonic"],
  });
}

/** Click through intro cards and skip other items until a bassMotion item awaits an answer. */
async function skipToBassMotion(page: Page): Promise<number[]> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const state = await page.getByTestId("session").getAttribute("data-state");
    if (state === "error" || state === "summary") throw new Error(`session ended early: ${state}`);
    const click = async (testId: string): Promise<void> => {
      await page
        .getByTestId(testId)
        .click({ timeout: 1_000 })
        .catch(() => undefined);
    };
    if (state === "orient" || state === "intro") await click("continue");
    else if (state === "feedback") await click("next");
    else if (state === "listening") {
      const roots = await page.evaluate(() => {
        const s = window.__clavisSession;
        const play = s?.expected?.play;
        if (s?.phase !== "listening-play" || play?.kind !== "sequence") return undefined;
        return play.octaveAgnostic && s.expected?.responseWindowMs === 12000
          ? play.midi
          : undefined;
      });
      if (roots) return roots;
      await click("skip");
    } else await page.waitForTimeout(100);
  }
  throw new Error("no bassMotion item appeared");
}

/** Play `midis` through the fake input, one every 400 ms, after the stimulus gate. */
async function playRoots(page: Page, midis: readonly number[]): Promise<void> {
  await page.evaluate((notes) => {
    const fake = window.__clavisFakeInput;
    if (!fake) throw new Error("no fake input");
    const base = fake.nowMs() + 300;
    notes.forEach((midi, i) => fake.emitNote(midi, { onsetMs: base + i * 400 }));
  }, midis);
}

test.describe("Away bass motion", () => {
  test.setTimeout(90_000);

  test("is offered in an Away session as a four-root answer", async ({ page }) => {
    await seedBassLearner(page);
    await page.goto(SESSION_URL);
    await page.getByTestId("start").click();
    const roots = await skipToBassMotion(page);
    expect(roots).toHaveLength(4);
    await expect(page.getByTestId("prompt")).toHaveText("Tap it on the keyboard");
  });

  test("giving the four roots in order passes", async ({ page }) => {
    await seedBassLearner(page);
    await page.goto(SESSION_URL);
    await page.getByTestId("start").click();
    const roots = await skipToBassMotion(page);
    await playRoots(page, roots);
    await expect(page.getByTestId("feedback")).toHaveAttribute("data-correct", "true");
    await expect(page.getByTestId("result")).toHaveText("Correct");
  });

  test("a wrong last root is named as a degree in the feedback", async ({ page }) => {
    await seedBassLearner(page);
    await page.goto(SESSION_URL);
    await page.getByTestId("start").click();
    const roots = await skipToBassMotion(page);
    // The tonic's tritone (#4) is never a root of I, IV, V or vi, so it cannot match by accident.
    const wrong = 48 + (((roots[0] ?? 0) + 6) % 12);
    await playRoots(page, [...roots.slice(0, 3), wrong]);
    await expect(page.getByTestId("feedback")).toHaveAttribute("data-correct", "false");
    await expect(page.getByTestId("issues")).toContainText("Note 4");
  });
});
