import { expect, test } from "@playwright/test";

/*
 * T8.5: a device that was signed in and then gets a 401 from sync shows a "Sign in to resume sync"
 * prompt on Home. A device that never signed in shows nothing.
 */

test.use({ serviceWorkers: "block" });

test("a 401 from sync after signing in shows the resume prompt on Home", async ({ page }) => {
  await page.route("**/api/**", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: "unauthorized" }),
    }),
  );
  await page.addInitScript(() => {
    localStorage.setItem("clavis.signedIn", "1");
  });
  const synced = page.waitForResponse((r) => r.url().includes("/api/sync/"));
  await page.goto("/");
  await synced; // the 401 is recorded; the next load reads the mark
  await page.reload();
  const prompt = page.getByTestId("session-expired");
  await expect(prompt).toBeVisible();
  await expect(prompt.getByRole("link", { name: "Sign in to resume sync" })).toHaveAttribute(
    "href",
    /settings/,
  );
});

test("an anonymous device never sees the prompt", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Clavis", level: 1 })).toBeVisible();
  await expect(page.getByTestId("session-expired")).toHaveCount(0);
});
