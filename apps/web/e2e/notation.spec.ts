import { expect, test } from "@playwright/test";

// T3.2 spike: the Verovio worker must start under the app CSP (wasm-unsafe-eval, same-origin
// module worker) and render every T3.1 fixture. The benchmark numbers are attached and logged so CI
// runs of Chromium and WebKit leave desktop figures behind. Spike data: the fixture ids below
// mirror the MEI in src/lib/notation/spike-mei.ts.

const FIXTURES: { label: string; key: string; ids: string[] }[] = [
  { label: "Bass F3, G major", key: "bassF3GMajor", ids: ["n1"] },
  { label: "D minor raised 7th", key: "dMinorRaised7th", ids: ["n1"] },
  { label: "Interval C3-G3", key: "intervalC3G3", ids: ["n1", "n2"] },
  { label: "Percussion rhythm", key: "percussionRhythm", ids: ["n1", "n2", "n3", "n4", "n5"] },
];

test("renders each fixture through the Verovio worker", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
  });
  page.on("pageerror", (err) => {
    errors.push(`pageerror: ${err.message}`);
  });

  await page.goto("/dev/notation");
  const score = page.getByTestId("score");

  for (const fixture of FIXTURES) {
    await page.getByRole("button", { name: fixture.label }).click();
    await expect(page.getByTestId("status")).toContainText(`Rendered ${fixture.key} `, {
      timeout: 30_000,
    });
    await expect(score.locator("svg").first()).toBeVisible();
    const noteCount = await score.locator("g.note").count();
    expect(noteCount).toBe(fixture.ids.length);
    for (const id of fixture.ids) {
      await expect(score.locator(`g.note#${id}`)).toHaveCount(1);
    }
  }

  expect(errors).toEqual([]);
});

test("benchmark reports timings", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.goto("/dev/notation");
  await page.getByTestId("benchmark").click();
  const json = page.getByTestId("bench-json");
  await expect(json).toBeVisible({ timeout: 90_000 });

  const text = (await json.textContent()) ?? "";
  const result = JSON.parse(text) as {
    coldInitMs: number;
    firstRenderMs: number;
    warmRenders: number;
    warmRoundTripMs: { p50: number; p95: number };
    verovioVersion: string;
  };
  expect(result.warmRenders).toBe(50);
  expect(result.coldInitMs).toBeGreaterThan(0);
  expect(result.firstRenderMs).toBeGreaterThan(0);
  expect(result.warmRoundTripMs.p95).toBeGreaterThanOrEqual(result.warmRoundTripMs.p50);
  expect(result.verovioVersion).toMatch(/\d/);
  await expect(page.locator('[data-testid="score"] g.note').first()).toBeVisible();

  console.log(`[notation benchmark ${testInfo.project.name}] ${JSON.stringify(result)}`);
  await testInfo.attach("notation-benchmark.json", {
    body: text,
    contentType: "application/json",
  });
});
