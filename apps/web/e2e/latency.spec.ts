import { expect, test } from "@playwright/test";

test("settings links to the latency screen", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("link", { name: "Latency calibration" }).click();
  await expect(page).toHaveURL(/\/settings\/latency$/);
  await expect(page.getByRole("heading", { name: "Latency calibration" })).toBeVisible();
  await expect(page.getByTestId("saved")).toHaveText("Not calibrated.");
  await expect(page.getByTestId("save")).toBeDisabled();
  await expect(page.getByTestId("start-mic")).toBeVisible();
});

// Taps are injected as context-clock times (the same path the pointer handler feeds after
// converting event.timeStamp), at a known offset from the scheduled clicks, so the result does not
// depend on real input timing. The run takes about 8 s of real audio time.
test("tap path: known offsets give an ok result, which saves and survives reload", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto("/settings/latency?test=1");
  await page.waitForFunction(() => window.__clavisLatency !== undefined);

  await page.getByTestId("start-tap").click();
  await expect(page.getByTestId("tap-pad")).toContainText("Tap along");

  // Deterministic jitter of +-8 ms around 90 ms, with one missed tap and one gross outlier.
  await page.evaluate(() => {
    const hook = window.__clavisLatency;
    if (!hook) throw new Error("hook missing");
    const clicks = hook.clickTimesMs();
    clicks.forEach((c, i) => {
      if (i === 6) return;
      const jitter = ((i * 7) % 5) * 4 - 8;
      const delta = i === 9 ? 200 : 90 + jitter;
      hook.injectTap(c + delta);
    });
  });
  await expect(page.getByTestId("tap-count")).toHaveText("Taps recorded: 11");

  await expect(page.getByTestId("tap-verdict")).toHaveText("ok", { timeout: 20_000 });
  const text = (await page.getByTestId("tap-result").textContent()) ?? "";
  const match = /Tap latency (-?[\d.]+) ms, spread ([\d.]+) ms/.exec(text);
  expect(match).not.toBeNull();
  expect(Math.abs(Number(match?.[1]) - 90)).toBeLessThan(10);
  expect(Number(match?.[2])).toBeLessThan(15);

  await page.getByTestId("save").click();
  await expect(page.getByTestId("message")).toHaveText("Saved.");
  await expect(page.getByTestId("saved")).toContainText("Tap:");

  await page.reload();
  await expect(page.getByTestId("saved")).toContainText(/Tap: \d+\.\d ms/);
  await expect(page.getByTestId("reset")).toBeEnabled();

  await page.getByTestId("reset").click();
  await expect(page.getByTestId("saved")).toHaveText("Not calibrated.");
  await page.reload();
  await expect(page.getByTestId("saved")).toHaveText("Not calibrated.");
});

test("tap path: real pointer taps on the pad are recorded", async ({ page }) => {
  await page.goto("/settings/latency");
  await page.getByTestId("start-tap").click();
  await expect(page.getByTestId("tap-pad")).toContainText("Tap along");
  await page.getByTestId("tap-pad").click();
  await page.getByTestId("tap-pad").click();
  await expect(page.getByTestId("tap-count")).toHaveText("Taps recorded: 2");
});
