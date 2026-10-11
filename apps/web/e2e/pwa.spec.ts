import { expect, test, type Page } from "@playwright/test";

async function waitForServiceWorkerControl(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

test("manifest is valid and linked, icons are served", async ({ page, request }) => {
  await page.goto("/");

  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(href).toBe("/manifest.webmanifest");

  const response = await request.get("/manifest.webmanifest");
  expect(response.ok()).toBe(true);
  const manifest = (await response.json()) as {
    name: string;
    short_name: string;
    display: string;
    start_url: string;
    scope: string;
    orientation: string;
    theme_color: string;
    background_color: string;
    icons: { src: string; sizes: string; type: string; purpose?: string }[];
  };
  expect(manifest).toMatchObject({
    name: "Clavis",
    short_name: "Clavis",
    display: "standalone",
    start_url: "/",
    scope: "/",
    orientation: "any",
  });
  expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
  expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
  expect(manifest.icons.map((i) => `${i.sizes}:${i.purpose ?? "any"}`).sort()).toEqual([
    "192x192:any",
    "512x512:any",
    "512x512:maskable",
  ]);

  for (const icon of [...manifest.icons.map((i) => i.src), "/icons/apple-touch-icon.png"]) {
    const res = await request.get(icon);
    expect(res.ok(), icon).toBe(true);
    expect(res.headers()["content-type"], icon).toContain("image/png");
  }
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
    "href",
    /\/icons\/apple-touch-icon\.png$/,
  );
});

test("service worker takes control", async ({ page }) => {
  await page.goto("/");
  await waitForServiceWorkerControl(page);
  const scriptURL = await page.evaluate(
    async () => (await navigator.serviceWorker.getRegistration())?.active?.scriptURL,
  );
  expect(scriptURL).toContain("/service-worker.js");
});

test("a visited route reloads while offline", async ({ page, context }) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await waitForServiceWorkerControl(page);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  // Client-side navigation keeps working offline too.
  await page.getByRole("link", { name: "Home" }).click();
  await expect(page.getByRole("heading", { name: "Clavis" })).toBeVisible();
});
