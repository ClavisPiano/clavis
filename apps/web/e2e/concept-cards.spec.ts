import { expect, test, type Page } from "@playwright/test";

/*
 * Concept cards in the session (T2.12), with fake input and a silent instrument. In fake mode
 * the runtime counts example plays in window.__clavisExamplesPlayed.
 */

const played = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __clavisExamplesPlayed?: number }).__clavisExamplesPlayed ?? 0,
  );

test.describe("concept cards", () => {
  test.setTimeout(90_000);

  test("warm-up card in full the first time, intro card, and About this skill mid-item", async ({
    page,
  }) => {
    await page.goto("/session?input=fake&budget=90");
    await page.getByTestId("start").click();

    // First warm-up: the whole card is shown, with playable examples.
    const orient = page.getByTestId("orient");
    await expect(orient).toBeVisible();
    const orientCard = orient.getByTestId("concept-card");
    await expect(orientCard).toHaveAttribute("data-card-id", "concept.orient");
    await expect(orientCard.getByTestId("card-howto")).toBeVisible();
    await orientCard.getByTestId("card-example").first().click();
    expect(await played(page)).toBe(1);
    await page.getByTestId("continue").click();

    // New skill: its card replaces the old placeholder.
    const intro = page.getByTestId("intro");
    await expect(intro).toBeVisible();
    const introCard = intro.getByTestId("concept-card");
    await expect(introCard).toHaveAttribute("data-card-id", "concept.degrees.major.135");
    await expect(introCard).toContainText("What you'll do");
    await introCard.getByTestId("card-example").nth(1).click();
    expect(await played(page)).toBe(2);
    await page.getByTestId("continue").click();

    // Mid-item: the card opens over a paused session and closing it resumes the item.
    await expect(page.getByTestId("whats-this")).toBeVisible();
    await page.getByTestId("whats-this").click();
    const overlay = page.getByTestId("card-overlay");
    await expect(overlay).toBeVisible();
    await expect(overlay.getByTestId("concept-card")).toHaveAttribute(
      "data-card-id",
      "concept.degrees.major.135",
    );
    await expect(page.getByTestId("session")).toHaveAttribute("data-state", "paused");
    await page.getByTestId("card-close").click();
    await expect(overlay).toHaveCount(0);
    await expect(page.getByTestId("session")).toHaveAttribute(
      "data-state",
      /^(presenting|listening)$/,
    );
  });

  test("later warm-ups show What's this? instead of the full card", async ({ page }) => {
    await page.goto("/session?input=fake&budget=90");
    await page.getByTestId("start").click();
    await expect(page.getByTestId("orient").getByTestId("concept-card")).toBeVisible();
    await page.getByTestId("continue").click();
    await expect(page.getByTestId("intro")).toBeVisible();
    await page.getByTestId("finish").click();
    await page.getByTestId("finish-end").click();
    await expect(page.getByTestId("session")).toHaveAttribute("data-state", "summary");

    await page.goto("/session?input=fake&budget=90");
    await page.getByTestId("start").click();
    const orient = page.getByTestId("orient");
    await expect(orient).toBeVisible();
    await expect(orient.getByTestId("concept-card")).toHaveCount(0);
    await orient.getByTestId("whats-this").click();
    await expect(page.getByTestId("card-overlay").getByTestId("concept-card")).toHaveAttribute(
      "data-card-id",
      "concept.orient",
    );
    await page.getByTestId("card-close").click();
    await expect(page.getByTestId("session")).toHaveAttribute("data-state", "orient");
  });
});

test.describe("concept tips in feedback", () => {
  test.setTimeout(90_000);

  test("a wrong sung degree shows a tip whose link opens the card", async ({ page }) => {
    await page.goto("/session?input=fake&budget=90");
    await page.getByTestId("start").click();
    await page.getByTestId("continue").click(); // warm-up
    await page.getByTestId("continue").click(); // intro card

    // Degree items open with a practice step; nothing is marked until Ready.
    await page.waitForFunction(() => window.__clavisSession?.phase === "listening-practice");
    await page.getByTestId("ready").click();

    // Sing a fourth below the target: always another diatonic degree (1->5, 3->7, 5->2).
    await page.waitForFunction(() => window.__clavisSession?.phase === "listening-sing");
    await page.evaluate(() => {
      const session = window.__clavisSession;
      const fake = window.__clavisFakeInput;
      const sing = session?.expected?.sing;
      if (!fake || sing?.kind !== "sungPitch") throw new Error("expected a sung degree");
      const hz = 440 * 2 ** ((sing.targetMidi - 5 - 69) / 12);
      const base = fake.nowMs() + 300;
      for (let t = 0; t <= 400; t += 20) fake.emitFrame({ hz, confidence: 1, atMs: base + t });
    });
    // Then play the right note so the attempt completes.
    await page.waitForFunction(() => window.__clavisSession?.phase === "listening-play");
    await page.evaluate(() => {
      const play = window.__clavisSession?.expected?.play;
      const fake = window.__clavisFakeInput;
      if (!fake || play?.kind !== "pitchClass") throw new Error("expected a played degree");
      fake.emitNote(play.targetMidi, { onsetMs: fake.nowMs() + 300 });
    });

    // Both parts must be right (R12), so a wrong sung note makes the attempt incorrect.
    const feedback = page.getByTestId("feedback");
    await expect(feedback).toHaveAttribute("data-correct", "false");
    await expect(feedback.getByTestId("issues")).toContainText(/You sang \d; the target was/);
    const tip = feedback.getByTestId("tip");
    await expect(tip).toContainText(/ while /);
    await tip.getByTestId("tip-more").click();
    await expect(page.getByTestId("card-overlay").getByTestId("concept-card")).toHaveAttribute(
      "data-card-id",
      "concept.degrees.major.135",
    );
    await page.getByTestId("card-close").click();
    await expect(page.getByTestId("session")).toHaveAttribute("data-state", "feedback");
  });
});
