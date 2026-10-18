import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { seedLearner } from "./read-helpers";

// T8.2: automated accessibility checks (axe) on the main pages, in the light and dark themes. This
// finds the mechanical problems (names, roles, contrast); it does not replace trying a screen reader.

/**
 * Rules switched off per page, each with a reason.
 * - /keyboard, label-content-name-mismatch (WCAG 2.5.3): the keys show short names ("C#4") but are
 *   announced as "C sharp 4", which reads better for a screen reader. Tests and the session click
 *   keys by the spoken name. Revisit if speech-input users report trouble saying the visible name.
 */
const DISABLED_RULES: Record<string, string[]> = {
  "/keyboard": ["label-content-name-mismatch"],
};

async function violations(page: Page, path: string): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .disableRules(DISABLED_RULES[path] ?? [])
    .analyze();
  return results.violations.map(
    (v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(" | ")})`,
  );
}

const PAGES = ["/", "/settings", "/progress", "/practice", "/install", "/keyboard", "/privacy"];

for (const scheme of ["light", "dark"] as const) {
  for (const path of PAGES) {
    test(`${path} has no axe violations (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await seedLearner(page, [{ nodeId: "ear.degrees.major.135" }], { newItemsPerDay: 7 });
      await page.goto(path);
      await expect(page.locator("h1").first()).toBeVisible();
      expect(await violations(page, path)).toEqual([]);
    });
  }
}

test("a displayed score has a description that does not name its notes", async ({ page }) => {
  await page.goto("/dev/notation");
  const description = page.getByTestId("notation-description").first();
  await expect(description).toBeAttached();
  await expect(description).toContainText("clef");
});
