import { expect, test, type Page } from "@playwright/test";

// T3.4: the notation runtime must start under the app CSP (wasm-unsafe-eval, same-origin module
// worker), render every T3.1 fixture through the real client and view, keep working offline from
// the asset cache, and still run the benchmark. Numbers are attached and logged so CI runs of
// Chromium and WebKit leave desktop figures behind.

const FIXTURES: { label: string; key: string; ids: string[] }[] = [
  { label: "Bass F3, G major", key: "bassF3GMajor", ids: ["n1"] },
  { label: "D minor raised 7th", key: "dMinorRaised7th", ids: ["n1"] },
  { label: "Interval C3-G3", key: "intervalC3G3", ids: ["n1", "n2"] },
  { label: "Percussion rhythm", key: "percussionRhythm", ids: ["n1", "n2", "n3", "n4", "n5"] },
];

async function waitForServiceWorkerControl(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

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
  // The first fixture renders on its own.
  await expect(score.locator("svg").first()).toBeVisible({ timeout: 30_000 });

  for (const fixture of FIXTURES) {
    await page.getByRole("button", { name: fixture.label }).click();
    await expect(page.getByTestId("status")).toContainText(`Rendered ${fixture.key} `, {
      timeout: 30_000,
    });
    await expect(score.locator("svg").first()).toBeVisible();
    expect(await score.locator("g.note").count()).toBe(fixture.ids.length);
    for (const id of fixture.ids) {
      await expect(score.locator(`g.note#${id}`)).toHaveCount(1);
    }
  }

  expect(errors).toEqual([]);
});

test("the staff follows the theme", async ({ page }) => {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/dev/notation");
    const note = page.getByTestId("score").locator("g.note").first();
    await expect(note).toBeVisible({ timeout: 30_000 });
    const [noteColor, bg] = await Promise.all([
      note.evaluate((el) => getComputedStyle(el).color),
      page.getByTestId("score").evaluate((el) => getComputedStyle(el).backgroundColor),
    ]);
    // Dark ink on a light card, light ink on a dark card.
    const luma = (css: string): number => {
      const m = /\d+(\.\d+)?/g;
      const [r = 0, g = 0, b = 0] = (css.match(m) ?? []).map(Number);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    if (scheme === "light") expect(luma(noteColor)).toBeLessThan(luma(bg));
    else expect(luma(noteColor)).toBeGreaterThan(luma(bg));
  }
});

test("renders offline after one online load", async ({ page, context }) => {
  test.setTimeout(120_000);
  await page.goto("/dev/notation");
  await expect(page.getByTestId("score").locator("svg").first()).toBeVisible({ timeout: 30_000 });
  await waitForServiceWorkerControl(page);

  // The worker is warmed in the background after the first online load. Wait for the asset cache
  // to hold the notation chunk and its worker dependency.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const cache = await caches.open("clavis-assets-v1");
          return (await cache.keys()).map((r) => r.url);
        }),
      { timeout: 60_000 },
    )
    .toEqual(
      expect.arrayContaining([
        expect.stringMatching(/verovio/),
        expect.stringMatching(/workers\/chunks\//),
      ]),
    );

  // The versioned precache must not hold it.
  const precached = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      if (!name.startsWith("clavis-precache-")) continue;
      urls.push(...(await (await caches.open(name)).keys()).map((r) => r.url));
    }
    return urls;
  });
  expect(precached.length).toBeGreaterThan(0);
  expect(precached.filter((u) => /verovio/i.test(u))).toEqual([]);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId("score").locator("svg").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("score").locator("g.note#n1")).toHaveCount(1);
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
  };
  expect(result.warmRenders).toBe(50);
  expect(result.coldInitMs).toBeGreaterThan(0);
  expect(result.firstRenderMs).toBeGreaterThan(0);
  expect(result.warmRoundTripMs.p95).toBeGreaterThanOrEqual(result.warmRoundTripMs.p50);
  await expect(page.locator('[data-testid="score"] g.note').first()).toBeVisible();

  console.log(`[notation benchmark ${testInfo.project.name}] ${JSON.stringify(result)}`);
  await testInfo.attach("notation-benchmark.json", {
    body: text,
    contentType: "application/json",
  });
});
