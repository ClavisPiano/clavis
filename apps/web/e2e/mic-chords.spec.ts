import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedLearner } from "./read-helpers";

/*
 * Chords on the microphone (T8.19, R31). Chromium plays a WAV of sustained C major chords as the
 * microphone. The item will not ask for exactly that, so this proves the plumbing end to end, not
 * accuracy: the setting, the take, Basic Pitch loading in its worker (model download, TensorFlow.js
 * backend, CSP) and a graded attempt coming back. Accuracy is reviewed with real playing (R31).
 */

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "fake microphone flags are Chromium only",
);

const RATE = 22_050;

/** 16-bit mono WAV of a C major chord (C3 E3 G3), eight seconds, looped by the browser. */
function chordWav(): Buffer {
  const n = RATE * 8;
  const pcm = Buffer.alloc(n * 2);
  const midis = [48, 52, 55];
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const env = Math.exp(-((t % 4) * 0.3)) * Math.min(1, (t % 4) / 0.01);
    let v = 0;
    for (const m of midis) {
      const f = 440 * 2 ** ((m - 69) / 12);
      for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f * h * t) / h ** 1.3;
    }
    pcm.writeInt16LE(Math.round((v / 8) * env * 0.9 * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const wavPath = join(mkdtempSync(join(tmpdir(), "clavis-mic-")), "chords.wav");
writeFileSync(wavPath, chordWav());

test.use({
  launchOptions: {
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${wavPath}`,
    ],
    ...(process.env.CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH }
      : {}),
  },
});

/** Click through the warm-up and skip until the chord item is listening in take mode. */
async function skipToChordItem(page: Page): Promise<void> {
  const deadline = Date.now() + 60_000;
  const click = async (testId: string): Promise<void> => {
    await page
      .getByTestId(testId)
      .click({ timeout: 1_000 })
      .catch(() => undefined);
  };
  while (Date.now() < deadline) {
    const state = await page.getByTestId("session").getAttribute("data-state");
    if (state === "error" || state === "summary") throw new Error(`session ended early: ${state}`);
    if (state === "orient" || state === "intro") await click("continue");
    else if (state === "feedback") await click("next");
    else if (state === "listening") {
      if ((await page.getByTestId("take-help").count()) > 0) return;
      await click("skip");
    } else await page.waitForTimeout(100);
  }
  throw new Error("no chord item appeared in take mode");
}

test("a chord answer on the mic is recorded, transcribed after Done, and graded", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const requested: string[] = [];
  page.on("request", (r) => requested.push(new URL(r.url()).pathname));

  await seedLearner(page, [{ nodeId: "hands.lh.triads.root", keyFamily: "A" }], {
    newItemsPerDay: 15,
  });

  // Off by default: the setting turns it on.
  await page.goto("/settings");
  await expect(page.getByTestId("mic-chords-help")).toBeVisible();
  await page.getByTestId("mic-chords").check();
  await page.getByTestId("save").click();
  await expect(page.getByTestId("saved")).toBeVisible();
  expect(requested.some((p) => p.includes("basic-pitch"))).toBe(false);

  await page.goto("/session?input=mic&audio=silent&budget=420&headphones=yes");
  await page.getByTestId("start").click();
  await skipToChordItem(page);
  await expect(page.getByTestId("prompt")).toContainText("left hand");

  // Let the take hear a few seconds of the chord, then say Done.
  await page.waitForTimeout(4_000);
  const doneAt = Date.now();
  await page.getByTestId("done").click();
  await expect(page.getByTestId("take-working")).toBeVisible();
  await expect(page.getByTestId("done")).toBeDisabled();

  // The model and its worker are fetched on this first take, and the attempt is graded.
  await expect(page.getByTestId("feedback")).toBeVisible({ timeout: 120_000 });
  const stats = await page.evaluate(
    () =>
      (window as unknown as { __clavisTranscribe?: Record<string, unknown> }).__clavisTranscribe,
  );
  // It finished (not the timeout), on a real backend, and found the three tones of the chord.
  expect(stats).toMatchObject({ ok: true });
  expect(Number(stats?.notes)).toBeGreaterThanOrEqual(3);
  expect(Date.now() - doneAt).toBeLessThan(45_000);
  expect(requested.some((p) => p.endsWith("/models/basic-pitch/model.json"))).toBe(true);
  expect(requested.some((p) => p.endsWith("/models/basic-pitch/group1-shard1of1.bin"))).toBe(true);
  expect(requested.some((p) => p.includes("/workers/basic-pitch.worker"))).toBe(true);
});

test("without the setting, the mic is not offered chords", async ({ page }) => {
  test.setTimeout(120_000);
  await seedLearner(page, [{ nodeId: "hands.lh.triads.root", keyFamily: "A" }], {
    newItemsPerDay: 15,
  });
  await page.goto("/session?input=mic&audio=silent&budget=420&headphones=yes");
  await page.getByTestId("start").click();
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const state = await page.getByTestId("session").getAttribute("data-state");
    if (state === "summary" || state === "nothing") break;
    if (state === "listening") {
      expect(await page.getByTestId("take-help").count()).toBe(0);
      await expect(page.getByTestId("prompt")).not.toContainText("left hand");
      await page
        .getByTestId("skip")
        .click({ timeout: 1_000 })
        .catch(() => undefined);
    } else if (state === "orient" || state === "intro") {
      await page
        .getByTestId("continue")
        .click({ timeout: 1_000 })
        .catch(() => undefined);
    } else if (state === "feedback") {
      await page
        .getByTestId("next")
        .click({ timeout: 1_000 })
        .catch(() => undefined);
    } else await page.waitForTimeout(100);
  }
});
