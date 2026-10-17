import { expect, test, type Page } from "@playwright/test";
import { seedLearner } from "./read-helpers";

/*
 * Monthly benchmark (T6.5): record, list and replay. The microphone is faked with a Web Audio
 * oscillator, so the real MediaRecorder records a real (playable) take. The page clock is fixed to
 * one day in September and then one in October, so the takes land in different months.
 */

test.use({ timezoneId: "UTC" });

const TREBLE = ["read.treble.landmarks", "read.treble.steps", "read.treble.skips"];
const SEPTEMBER = Date.parse("2026-09-15T12:00:00Z");
const OCTOBER = Date.parse("2026-10-15T12:00:00Z");

async function fakeMicrophone(page: Page): Promise<void> {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      osc.frequency.value = 440;
      const dest = ctx.createMediaStreamDestination();
      osc.connect(dest);
      osc.start();
      await ctx.resume();
      return dest.stream;
    };
  });
}

/** Record a take of about `ms` on the record page and save it. */
async function recordTake(page: Page, ms = 1500): Promise<void> {
  await expect(page.getByTestId("benchmark-option").first()).toBeVisible();
  await page.getByTestId("record-start").click();
  await expect(page.getByTestId("record-timer")).toBeVisible();
  await page.waitForTimeout(ms);
  await page.getByTestId("record-stop").click();
  await expect(page.getByTestId("record-preview")).toBeVisible();
  await page.getByTestId("record-save").click();
  await expect(page).toHaveURL(/\/progress\/benchmarks$/);
}

/** Keys in the local recording store, read straight from IndexedDB. */
async function blobKeys(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("clavis");
      req.onsuccess = () => {
        resolve(req.result);
      };
      req.onerror = () => {
        reject(req.error ?? new Error("open failed"));
      };
    });
    const keys = await new Promise<string[]>((resolve, reject) => {
      const req = db.transaction("blobs").objectStore("blobs").getAllKeys();
      req.onsuccess = () => {
        resolve(req.result as string[]);
      };
      req.onerror = () => {
        reject(req.error ?? new Error("read failed"));
      };
    });
    db.close();
    return keys.sort();
  });
}

test.describe("Monthly benchmark", () => {
  test.setTimeout(120_000);
  // The fake microphone (a Web Audio stream into MediaRecorder) is only exercised on Chromium.
  test.skip(({ browserName }) => browserName !== "chromium", "Chromium fake microphone");

  test("record in two months, list by piece and replay side by side", async ({ page }) => {
    await fakeMicrophone(page);
    await page.clock.setFixedTime(SEPTEMBER);
    await seedLearner(page, [], { placedMastered: TREBLE });

    // September: Home prompts, and the take is saved.
    await page.goto("/");
    await expect(page.getByTestId("benchmark-prompt")).toBeVisible();
    await page.getByTestId("benchmark-record-link").click();
    await expect(page).toHaveURL(/\/progress\/benchmarks\/record$/);
    // Four unlocked treble pieces, the hardest preselected; the score is drawn.
    await expect(page.getByTestId("benchmark-option")).toHaveCount(4);
    await expect(page.getByLabel("Twinkle, Twinkle, Little Star")).toBeChecked();
    await expect(page.getByTestId("notation")).toBeVisible();
    await recordTake(page);

    await expect(page.getByTestId("benchmark-piece")).toHaveCount(1);
    await expect(page.getByTestId("benchmark-months")).toHaveText("September 2026");
    await expect(page.getByTestId("player-latest").locator("audio")).toBeVisible();
    await expect(page.getByTestId("no-earlier")).toBeVisible();
    await expect(page.getByTestId("benchmark-record-link")).toHaveCount(0);
    await page.goto("/");
    await expect(page.getByTestId("benchmark-prompt")).toHaveCount(0);

    // October: /progress prompts again; record the same piece.
    await page.clock.setFixedTime(OCTOBER);
    await page.goto("/progress");
    await expect(page.getByTestId("benchmarks-link")).toBeVisible();
    await page.getByTestId("benchmark-card").getByTestId("benchmark-record-link").click();
    await expect(page.getByTestId("record-replaces")).toHaveCount(0);
    await recordTake(page);

    const compare = page.getByTestId("benchmark-compare");
    await expect(compare.getByTestId("notation")).toHaveCount(1);
    await expect(page.getByTestId("benchmark-months")).toHaveText("October 2026, September 2026");
    await expect(page.getByTestId("player-latest")).toHaveAttribute("data-month", "2026-10");
    await expect(page.getByTestId("player-latest")).toContainText("October 2026 (this month)");
    await expect(page.getByTestId("player-earlier")).toHaveAttribute("data-month", "2026-09");
    await expect(page.getByTestId("earlier-month")).toHaveValue("2026-09");
    expect(await blobKeys(page)).toHaveLength(2);

    // Play one after the other: this month first, then the earlier take, then done.
    const playBoth = page.getByTestId("play-both");
    await expect(playBoth).toBeEnabled();
    await playBoth.click();
    await expect(playBoth).toHaveAttribute("data-sequence", "latest");
    await expect(playBoth).toHaveAttribute("data-sequence", "earlier", { timeout: 15_000 });
    await expect(playBoth).toHaveAttribute("data-sequence", "", { timeout: 15_000 });
  });

  test("recording again in the same month replaces the take and its audio", async ({ page }) => {
    await fakeMicrophone(page);
    await page.clock.setFixedTime(OCTOBER);
    await seedLearner(page, [], { placedMastered: TREBLE });

    await page.goto("/progress/benchmarks/record");
    await recordTake(page, 800);
    const first = await blobKeys(page);
    expect(first).toHaveLength(1);

    // A later time in the same month (the page clock is frozen, so move it on).
    await page.clock.setFixedTime(OCTOBER + 3_600_000);
    await page.goto("/progress/benchmarks/record");
    await expect(page.getByTestId("record-replaces")).toContainText("October 2026");
    await page.getByLabel("Ode to Joy").check();
    await recordTake(page, 800);

    // One October benchmark, on the new piece, and only the new audio is kept.
    await expect(page.getByTestId("benchmark-piece")).toHaveCount(1);
    await expect(page.getByTestId("benchmark-piece")).toHaveAttribute(
      "data-piece",
      "piece.ode-to-joy",
    );
    const after = await blobKeys(page);
    expect(after).toHaveLength(1);
    expect(after).not.toEqual(first);
  });
});
