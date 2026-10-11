import { expect, test, type Page } from "@playwright/test";
import {
  expectNotationDrawn,
  presentedReadTarget,
  seedLearner,
  skipToReadItem,
} from "./read-helpers";

/*
 * Away READ on the on-screen keyboard (T3.11, on the real generator since T3.15). The learner has
 * `ear.rhythm.echo` (tapped, so no microphone is needed) and `read.bass.landmarks` introduced
 * (family A), so the Away session is an ear block followed by a read block of bass staff notes. The ear items are skipped. The reading
 * target is not on screen, so the specs read it from the event log (/dev/events) of a second page.
 * Input is the real tap adapter on the real on-screen keyboard, with silent audio.
 */

async function seedReadLearner(page: Page): Promise<void> {
  await seedLearner(page, [
    { nodeId: "ear.rhythm.echo" },
    { nodeId: "read.bass.landmarks", keyFamily: "A" },
  ]);
}

/** Start the Away session and wait for a reading item. Returns its target midi. */
async function startAwayRead(page: Page): Promise<number> {
  await page.goto("/session?mode=away&input=tap&audio=silent&budget=60");
  await page.getByTestId("start").click();
  await skipToReadItem(page);
  await expect(page.getByTestId("prompt")).toHaveText("Find it on the keyboard");
  await expectNotationDrawn(page);
  return presentedReadTarget(page);
}

test.describe("Away READ", () => {
  test.setTimeout(90_000);

  test("keyboard covers the item's register and does not reveal the target", async ({ page }) => {
    await seedReadLearner(page);
    const target = await startAwayRead(page);
    // The bass reading range is C2..E4 (36..64): C2 is reachable and the keys run an octave either
    // side of it (24..76), so an octave error is a key that exists.
    expect(target).toBeGreaterThanOrEqual(36);
    expect(target).toBeLessThanOrEqual(64);
    await expect(page.locator('[data-midi="36"]')).toHaveAttribute("aria-label", "C 2");
    await expect(page.locator('[data-midi="24"]')).toHaveCount(1);
    await expect(page.locator('[data-midi="76"]')).toHaveCount(1);
    await expect(page.locator('[data-midi="20"]')).toHaveCount(0);
    await expect(page.locator('[data-midi="80"]')).toHaveCount(0);
    await expect(page.locator(".key.highlight")).toHaveCount(0);
  });

  test("a correct tap passes", async ({ page }) => {
    await seedReadLearner(page);
    const target = await startAwayRead(page);
    await page.locator(`[data-midi="${String(target)}"]`).click();
    await expect(page.getByTestId("feedback")).toHaveAttribute("data-correct", "true");
    await expect(page.getByTestId("result")).toHaveText("Correct");
  });

  test("a tap an octave above gives pitch.octave", async ({ page }) => {
    await seedReadLearner(page);
    const target = await startAwayRead(page);
    await page.locator(`[data-midi="${String(target + 12)}"]`).click();
    // A wrong note does not end the item by itself: the learner can retry or tap Done.
    await page.getByTestId("done").click();
    await expect(page.getByTestId("feedback")).toHaveAttribute("data-correct", "false");
    await expect(page.getByTestId("tip")).toContainText("Right letter, wrong octave");
  });
});
