import { expect, test, type Page } from "@playwright/test";
import { seedLearner } from "./read-helpers";
import { runToSummary } from "./session-helpers";

/*
 * Pieces (MP, TP.5): the Home card, learning a piece's phrases in a normal session, and playing it
 * through. The learner has the treble reading chain placed (so the first tune is unlocked). Fake
 * input answers every phrase correctly, as in the other session specs.
 */

const TREBLE = ["read.treble.landmarks", "read.treble.steps", "read.treble.skips"];
const HCB = "piece.hot-cross-buns";

async function waitForServiceWorkerControl(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

/** How many events of a type are stored, read from the event log page of a second tab. */
async function countEvents(page: Page, type: string, filter?: string): Promise<number> {
  const log = await page.context().newPage();
  try {
    await log.goto("/dev/events");
    await expect(log.getByTestId("events")).toBeVisible();
    let events = log.getByTestId("event").filter({ hasText: type });
    if (filter !== undefined) events = log.locator(`[data-testid="event"]${filter}`);
    return await events.count();
  } finally {
    await log.close();
  }
}

test.describe("Pieces", () => {
  test.setTimeout(180_000);

  test("Home says the first tune is locked until treble reading is fluent, and what it needs", async ({
    page,
  }) => {
    await seedLearner(page, []);
    await page.goto("/");
    await expect(page.getByTestId("piece-card")).toBeVisible();
    await expect(page.getByTestId("first-piece-locked")).toBeVisible();
    await expect(page.getByTestId("play-through")).toHaveCount(0);
    await page.getByText("All pieces").click();
    const first = page.getByTestId("piece-row").first();
    await expect(first).toHaveAttribute("data-status", "locked");
    await expect(first).toContainText("Locked: needs Treble landmarks, Treble steps, Treble skips");
  });

  test("a treble learner is offered the first piece, and a session teaches its phrases", async ({
    page,
  }) => {
    await seedLearner(page, [], { placedMastered: TREBLE });
    await page.goto("/");
    await expect(page.getByTestId("current-title")).toHaveText("Hot Cross Buns");
    await expect(page.getByTestId("phrase-progress")).toHaveAttribute(
      "aria-label",
      "0 of 2 phrases learned",
    );
    await expect(page.getByTestId("play-through")).toHaveCount(0);

    await page.goto("/session?input=fake&audio=silent&budget=420");
    await page.getByTestId("start").click();
    const phases = await runToSummary(page);
    expect(phases.length).toBeGreaterThan(0);

    // Both phrases were new, presented in the Apply block and played right.
    expect(await countEvents(page, "", '[data-block="apply"][data-generator="pieceLine"]')).toBe(2);
    await page.getByTestId("home").click();
    await expect(page.getByTestId("phrase-progress")).toHaveAttribute(
      "aria-label",
      "2 of 2 phrases learned",
    );
    const play = page.getByTestId("play-through");
    await expect(play).toBeVisible();
    await expect(play).toHaveAttribute("href", new RegExp(`/session\\?run=${HCB}$`));
  });

  test("playing a piece through marks the milestone, which survives a reload and offline", async ({
    page,
    context,
  }) => {
    await seedLearner(page, [], {
      placedMastered: TREBLE,
      pieceAttempts: [
        { pieceId: HCB, phrase: 1, correct: true },
        { pieceId: HCB, phrase: 2, correct: true },
      ],
    });
    await page.goto("/");
    const href = await page.getByTestId("play-through").getAttribute("href");
    expect(href).toContain(`run=${HCB}`);

    const url = new URL(href ?? "", page.url());
    url.searchParams.set("input", "fake");
    url.searchParams.set("audio", "silent");
    await page.goto(url.toString());
    await page.getByTestId("start").click();
    const phases = await runToSummary(page);
    // Two phrases, one answer each, nothing else in the session.
    expect(phases).toEqual(["listening-play", "listening-play"]);

    const moment = page.getByTestId("piece-moment");
    await expect(moment).toHaveAttribute("data-complete", "true");
    await expect(moment).toContainText("You played Hot Cross Buns through");

    // The run is in the event log as piece.completed, once, after its two phrases.
    expect(await countEvents(page, "piece.completed")).toBe(1);

    await page.getByTestId("home").click();
    await expect(page.getByTestId("milestones")).toContainText("Hot Cross Buns");
    await expect(page.getByTestId("current-title")).toHaveText("Ode to Joy");
    await expect(page.getByTestId("play-through")).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId("milestones")).toContainText("Hot Cross Buns");

    await waitForServiceWorkerControl(page);
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByTestId("milestones")).toContainText("Hot Cross Buns");
    await expect(page.getByTestId("current-title")).toHaveText("Ode to Joy");
  });

  test("a run with a wrong phrase is not a completion", async ({ page }) => {
    await seedLearner(page, [], {
      placedMastered: TREBLE,
      pieceAttempts: [
        { pieceId: HCB, phrase: 1, correct: true },
        { pieceId: HCB, phrase: 2, correct: true },
      ],
    });
    await page.goto(`/session?run=${HCB}&input=fake&audio=silent`);
    await page.getByTestId("start").click();
    // Answer the first phrase right, then skip the second.
    const deadline = Date.now() + 60_000;
    let answered = false;
    while (Date.now() < deadline) {
      const state = await page.getByTestId("session").getAttribute("data-state");
      if (state === "summary") break;
      if (state === "listening" && !answered) {
        await page.evaluate(() => {
          const fake = window.__clavisFakeInput;
          const play = window.__clavisSession?.expected?.play;
          if (!fake || play?.kind !== "line") return;
          const beatMs = 60000 / play.tempoBpm;
          play.midi.forEach((midi, i) =>
            fake.emitNote(midi, {
              onsetMs: fake.nowMs() + 300 + (play.onsetsBeats[i] ?? 0) * beatMs,
            }),
          );
        });
        answered = true;
        await page.waitForFunction(() => window.__clavisSession?.phase !== "listening-play", null, {
          timeout: 20_000,
        });
      } else if (state === "listening") {
        await page
          .getByTestId("skip")
          .click({ timeout: 1_000 })
          .catch(() => undefined);
      } else if (state === "feedback") {
        await page
          .getByTestId("next")
          .click({ timeout: 1_000 })
          .catch(() => undefined);
      } else {
        await page.waitForTimeout(100);
      }
    }
    expect(await countEvents(page, "piece.completed")).toBe(1);
    const moment = page.getByTestId("piece-moment");
    await expect(moment).toHaveAttribute("data-complete", "false");
    await expect(moment).toContainText("1 of 2 phrases right");
    await page.getByTestId("home").click();
    await expect(page.getByTestId("milestones")).toHaveCount(0);
    await expect(page.getByTestId("play-through")).toBeVisible();
  });
});
