import { expect, test, type Page } from "@playwright/test";
import { seedLearner } from "./read-helpers";
import { runToSummary } from "./session-helpers";

/*
 * Import a MusicXML file as a personal piece (T7.4): upload, preview, save, see it on Home, play a
 * phrase of it in a session. Unsupported files show a plain message and cannot be saved. Fake
 * input answers every phrase correctly, as in the other session specs.
 */

const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;
const fixture = (name: string): string => `${FIXTURES}${name}`;

/** How many stored events match, read from the event log page of a second tab. */
async function countEvents(page: Page, selector: string): Promise<number> {
  const log = await page.context().newPage();
  try {
    await log.goto("/dev/events");
    await expect(log.getByTestId("events")).toBeVisible();
    return await log.locator(`[data-testid="event"]${selector}`).count();
  } finally {
    await log.close();
  }
}

async function openImport(page: Page): Promise<void> {
  await seedLearner(page, []);
  await page.goto("/");
  await expect(page.getByTestId("piece-card")).toBeVisible();
  await page.getByTestId("import-piece").click();
  await expect(page).toHaveURL(/\/pieces\/import$/);
}

test.describe("Import a piece", () => {
  test.setTimeout(180_000);

  test("upload, preview, save, then the piece is on Home and a phrase can be played", async ({
    page,
  }) => {
    await openImport(page);
    await page.getByTestId("import-file").setInputFiles(fixture("little-tune.musicxml"));

    // The preview draws the staff, and the page reports phrases and difficulty.
    await expect(page.getByTestId("import-preview")).toBeVisible();
    await expect(page.getByTestId("notation")).toBeVisible();
    await expect(page.getByTestId("phrase-count")).toHaveText("2");
    await expect(page.getByTestId("difficulty")).toHaveText(/^\d+$/);
    await expect(page.getByTestId("import-error")).toHaveCount(0);
    // The title starts from the score's own title and can be edited.
    await expect(page.getByTestId("import-title")).toHaveValue("Little Tune");
    await page.getByTestId("import-title").fill("My Little Tune");

    await page.getByTestId("import-save").click();
    await expect(page).toHaveURL(/\/$/);

    // The piece is unlocked at once and is the current piece.
    await expect(page.getByTestId("current-title")).toHaveText("My Little Tune");
    await expect(page.getByTestId("phrase-progress")).toHaveAttribute(
      "aria-label",
      "0 of 2 phrases learned",
    );
    await page.getByText("All pieces").click();
    const row = page.getByTestId("piece-row").first();
    await expect(row).toContainText("My Little Tune");
    await expect(row).toHaveAttribute("data-status", "playing");
    expect(await countEvents(page, ":has-text('content.imported')")).toBe(1);

    // It survives a reload (derived from the event log).
    await page.reload();
    await expect(page.getByTestId("current-title")).toHaveText("My Little Tune");

    // A session teaches its phrases like any piece's.
    await page.goto("/session?input=fake&audio=silent&budget=420");
    await page.getByTestId("start").click();
    await runToSummary(page);
    expect(await countEvents(page, '[data-block="apply"][data-generator="pieceLine"]')).toBe(2);
    await page.getByTestId("home").click();
    await expect(page.getByTestId("phrase-progress")).toHaveAttribute(
      "aria-label",
      "2 of 2 phrases learned",
    );
    await expect(page.getByTestId("play-through")).toBeVisible();
  });

  test("an unsupported file (two voices) shows its error and cannot be saved", async ({ page }) => {
    await openImport(page);
    await page.getByTestId("import-file").setInputFiles(fixture("two-voices.musicxml"));
    await expect(page.getByTestId("import-error")).toContainText("more than one voice");
    await expect(page.getByTestId("import-save")).toHaveCount(0);
    await expect(page.getByTestId("import-preview")).toHaveCount(0);

    // Choosing a good file afterwards clears the error.
    await page.getByTestId("import-file").setInputFiles(fixture("little-tune.musicxml"));
    await expect(page.getByTestId("import-preview")).toBeVisible();
    await expect(page.getByTestId("import-error")).toHaveCount(0);
  });

  test("a pickup bar is explained, not a crash", async ({ page }) => {
    await openImport(page);
    await page.getByTestId("import-file").setInputFiles(fixture("pickup.musicxml"));
    await expect(page.getByTestId("import-error")).toHaveText(
      "This score has a pickup bar or incomplete measures; that is not supported yet.",
    );
    await expect(page.getByTestId("import-save")).toHaveCount(0);
  });

  test("a file that is not a score is refused with a message", async ({ page }) => {
    await openImport(page);
    await page.getByTestId("import-file").setInputFiles({
      name: "notes.xml",
      mimeType: "text/xml",
      buffer: Buffer.from("this is not xml"),
    });
    await expect(page.getByTestId("import-error")).toContainText("could not be read");
    await expect(page.getByTestId("import-save")).toHaveCount(0);
  });

  test("a grand staff file asks which staff, and the lower staff imports as bass", async ({
    page,
  }) => {
    await openImport(page);
    await page.getByTestId("import-file").setInputFiles(fixture("piano-two-staves.musicxml"));
    await expect(page.getByTestId("import-staff")).toBeVisible();
    await expect(page.getByTestId("import-part")).toHaveCount(0);
    await expect(page.getByTestId("import-title")).toHaveValue("Piano Duet");
    await expect(page.getByTestId("notation")).toHaveAttribute("aria-label", /phrase 1 of 1/);

    await page.getByTestId("import-staff").selectOption("2");
    await expect(page.getByTestId("import-error")).toHaveCount(0);
    await expect(page.getByTestId("phrase-count")).toHaveText("1");
    await page.getByTestId("import-save").click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("current-title")).toHaveText("Piano Duet");
    await expect(page.getByTestId("current-piece")).toContainText("Left hand");
  });

  test("an empty title blocks saving", async ({ page }) => {
    await openImport(page);
    await page.getByTestId("import-file").setInputFiles(fixture("little-tune.musicxml"));
    await expect(page.getByTestId("import-preview")).toBeVisible();
    await page.getByTestId("import-title").fill("   ");
    await expect(page.getByTestId("title-error")).toBeVisible();
    await expect(page.getByTestId("import-save")).toBeDisabled();
  });
});
