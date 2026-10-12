import { expect, test } from "@playwright/test";

// /dev/record guides the take on screen. Chromium only: it fakes the microphone with launch flags
// that WebKit rejects, so other projects skip the file before a browser is launched.
test.skip(
  ({ browserName }) => browserName !== "chromium",
  "fake microphone flags are Chromium only",
);
test.use({
  launchOptions: {
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
    ...(process.env.CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH }
      : {}),
  },
});

test("the bass take is offered and recording shows a count-in then the note to play", async ({
  page,
}) => {
  test.setTimeout(30_000);
  await page.goto("/dev/record");
  await expect(page.getByTestId("rec-take")).toHaveValue("singles-bass");

  await page.getByTestId("rec-start").click();
  const cue = page.getByTestId("rec-cue");
  await expect(cue).toContainText("Get ready");
  // 40 bpm: the count-in takes 6 s, then the first note is C2.
  await expect(cue).toContainText("C2", { timeout: 10_000 });
  await expect(cue).toContainText("Next: C#2");

  await page.getByTestId("rec-stop").click();
  await expect(page.getByTestId("rec-message")).toHaveText("Stopped. Nothing was saved.");
  await expect(page.getByTestId("rec-start")).toBeEnabled();
});

test("a finished take is analysed on the device and offered for download", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/dev/record");
  await page.getByTestId("rec-take").selectOption("melody-arpeggio");
  await page.getByTestId("rec-start").click();
  // 60 bpm, 4 count-in beats and 10 notes: about 16 s. The fake mic plays a beep, not the notes.
  const result = page.getByTestId("rec-result");
  await expect(result).toBeVisible({ timeout: 40_000 });
  await expect(result).toContainText("of 10 notes");
  await expect(result.getByRole("button", { name: "Download WAV + JSON" })).toBeVisible();
});
