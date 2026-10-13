import { expect, test, type Page } from "@playwright/test";
import {
  expectNotationDrawn,
  presentedReadTarget,
  seedLearner,
  skipToReadItem,
} from "./read-helpers";

/*
 * Treble reading (TP.2) in an Away session on the on-screen keyboard. The learner has
 * `ear.rhythm.echo` (tapped, so no microphone is needed) and `read.treble.landmarks` introduced
 * (family A), so the read block is treble staff notes. The ear items are skipped. The target is not
 * on screen, so the specs read it from the event log (/dev/events) of a second page.
 */

async function seedTrebleLearner(page: Page): Promise<void> {
  await seedLearner(page, [
    { nodeId: "ear.rhythm.echo" },
    { nodeId: "read.treble.landmarks", keyFamily: "A" },
  ]);
}

/** Start the Away session and wait for a reading item. Returns its target midi. */
async function startAwayTreble(page: Page): Promise<number> {
  await page.goto("/session?mode=away&input=tap&audio=silent&budget=60");
  await page.getByTestId("start").click();
  await skipToReadItem(page);
  await expect(page.getByTestId("prompt")).toHaveText("Find it on the keyboard");
  await expectNotationDrawn(page);
  return presentedReadTarget(page, "trebleNoteRead");
}

test.describe("Away treble reading", () => {
  test.setTimeout(90_000);

  test("draws a treble staff and the keyboard reaches the treble register", async ({ page }) => {
    await seedTrebleLearner(page);
    const target = await startAwayTreble(page);
    // The treble landmarks are middle C, the clef's G and the C above: C4, G4, C5 in C major.
    expect([60, 67, 72]).toContain(target);
    // SMuFL G clef (U+E050) is drawn; the F clef (U+E062) is not.
    const slot = page.getByTestId("notation-slot");
    await expect(slot.locator('use[href^="#E050"], use[*|href^="#E050"]').first()).toBeAttached();
    await expect(slot.locator('use[href^="#E062"], use[*|href^="#E062"]')).toHaveCount(0);
    // Middle C and the C above are reachable, and the register does not reveal the target.
    await expect(page.locator('[data-midi="60"]')).toHaveAttribute("aria-label", "C 4");
    await expect(page.locator('[data-midi="72"]')).toHaveCount(1);
    await expect(page.locator(".key.highlight")).toHaveCount(0);
  });

  test("a correct tap passes", async ({ page }) => {
    await seedTrebleLearner(page);
    const target = await startAwayTreble(page);
    await page.locator(`[data-midi="${String(target)}"]`).click();
    await expect(page.getByTestId("feedback")).toHaveAttribute("data-correct", "true");
    await expect(page.getByTestId("result")).toHaveText("Correct");
  });

  test("a tap an octave above gives the octave tip", async ({ page }) => {
    await seedTrebleLearner(page);
    const target = await startAwayTreble(page);
    await page.locator(`[data-midi="${String(target + 12)}"]`).click();
    await page.getByTestId("done").click();
    await expect(page.getByTestId("feedback")).toHaveAttribute("data-correct", "false");
    await expect(page.getByTestId("tip")).toContainText("Right letter, wrong octave");
  });
});
