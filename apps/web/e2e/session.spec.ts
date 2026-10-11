import { expect, test, type Page } from "@playwright/test";

/*
 * Full sessions with fake input and a silent instrument (?input=fake implies ?audio=silent).
 * The page exposes window.__clavisSession (what the current item expects) and
 * window.__clavisFakeInput (to play it), so each item is answered correctly.
 */

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
  });
  page.on("pageerror", (err) => {
    errors.push(`pageerror: ${err.message}`);
  });
  return errors;
}

/** Answer whatever the current listening phase expects, correctly. */
async function answerCurrentPhase(page: Page): Promise<void> {
  await page.evaluate(() => {
    const session = window.__clavisSession;
    const fake = window.__clavisFakeInput;
    const expected = session?.expected;
    if (!session || !fake || !expected) return;
    // Answers start after the gate (stimulus end plus tail, or phase start plus tail).
    const base = fake.nowMs() + 300;
    if (session.phase === "listening-sing" && expected.sing) {
      const sing = expected.sing;
      const midis = sing.kind === "sungPitch" ? [sing.targetMidi] : sing.midi;
      midis.forEach((midi, i) => {
        const hz = 440 * 2 ** ((midi - 69) / 12);
        for (let t = 0; t <= 300; t += 20) {
          fake.emitFrame({ hz, confidence: 1, atMs: base + i * 400 + t });
        }
      });
    } else if (session.phase === "listening-play" && expected.play) {
      const play = expected.play;
      if (play.kind === "pitchClass" || play.kind === "exactPitch") {
        fake.emitNote(play.targetMidi, { onsetMs: base });
      } else if (play.kind === "sequence") {
        play.midi.forEach((midi, i) => fake.emitNote(midi, { onsetMs: base + i * 400 }));
      } else {
        const beatMs = 60000 / play.tempoBpm;
        for (const beat of play.onsetsBeats) {
          fake.emitNote(play.pitch ?? 60, { onsetMs: base + beat * beatMs });
        }
      }
    }
  });
}

/** Click through the whole session until the summary shows. Returns the phases it answered. */
async function runToSummary(page: Page): Promise<string[]> {
  const answered: string[] = [];
  const deadline = Date.now() + 100_000;
  while (Date.now() < deadline) {
    const state = await page.getByTestId("session").getAttribute("data-state");
    if (state === "summary") return answered;
    if (state === "error") throw new Error("session reached the error state");
    if (state === "orient" || state === "intro") {
      await page.getByTestId("continue").click();
    } else if (state === "feedback") {
      const next = page.getByTestId("next");
      if (await next.isVisible()) await next.click();
      else await page.waitForTimeout(100);
    } else if (state === "listening") {
      const phase = await page.evaluate(() => window.__clavisSession?.phase ?? "");
      answered.push(phase);
      await answerCurrentPhase(page);
      // Leave the phase before looking again (a phase ends once the answer is complete).
      await page.waitForFunction((before) => window.__clavisSession?.phase !== before, phase, {
        timeout: 20_000,
      });
    } else {
      await page.waitForTimeout(100);
    }
  }
  throw new Error("session did not finish in time");
}

/** Event types from /dev/events, oldest first. */
async function storedEventTypes(page: Page): Promise<string[]> {
  await page.goto("/dev/events");
  await expect(page.getByTestId("events")).toBeVisible();
  const texts = await page.getByTestId("event").locator("strong").allTextContents();
  return texts.reverse();
}

test.describe("session runner", () => {
  test.setTimeout(150_000);

  test("instrument mode: a whole session with fake input, then the event log", async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto("/session?input=fake&budget=90");
    await expect(page.getByTestId("start")).toBeVisible();
    await page.getByTestId("start").click();
    await expect(page.getByTestId("orient")).toBeVisible();
    await expect(page.getByTestId("key")).toContainText("C major");

    const answered = await runToSummary(page);
    // Degree items are sung and then played at the instrument.
    expect(answered).toContain("listening-sing");
    expect(answered).toContain("listening-play");

    await expect(page.getByTestId("summary")).toBeVisible();
    await expect(page.getByTestId("summary-items")).toHaveText("3");
    await expect(page.getByTestId("summary-accuracy")).toHaveText("100%");
    await expect(page.getByTestId("node-changes")).toContainText("Degrees 1, 3, 5");

    const types = await storedEventTypes(page);
    const first = types.indexOf("session.started");
    expect(first).toBeGreaterThan(-1);
    expect(types.slice(first)).toEqual([
      "session.started",
      "node.introduced",
      "item.presented",
      "attempt.completed",
      "item.presented",
      "attempt.completed",
      "item.presented",
      "attempt.completed",
      "session.ended",
    ]);
    expect(errors).toEqual([]);
  });

  test("Away mode: no orient block, sung and tapped answers", async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto("/session?mode=away&input=fake&budget=60");
    await page.getByTestId("start").click();
    // Away goes straight to the intro card for the new skill: there is no orient block.
    await expect(page.getByTestId("intro")).toBeVisible();
    await expect(page.getByTestId("orient")).toHaveCount(0);

    await runToSummary(page);
    await expect(page.getByTestId("summary-accuracy")).toHaveText("100%");

    const types = await storedEventTypes(page);
    const first = types.indexOf("session.started");
    const session = types.slice(first);
    expect(session[0]).toBe("session.started");
    expect(session.at(-1)).toBe("session.ended");
    expect(session.filter((t) => t === "attempt.completed").length).toBeGreaterThan(0);
    expect(session.filter((t) => t === "item.presented")).toHaveLength(
      session.filter((t) => t === "attempt.completed").length,
    );
    expect(errors).toEqual([]);
  });

  test("the headphones prompt appears once, then the answer is stored as a setting", async ({
    page,
  }) => {
    await page.goto("/session?input=fake&budget=60&headphones=ask");
    await page.getByTestId("start").click();
    await expect(page.getByRole("heading", { name: "Using headphones?" })).toBeVisible();
    await page.getByTestId("headphones-yes").click();
    await expect(page.getByTestId("orient")).toBeVisible();
    await page.getByTestId("finish").click();
    await expect(page.getByTestId("summary")).toBeVisible();
    const types = await storedEventTypes(page);
    expect(types).toContain("settings.changed");
  });

  test("the test hook is only exposed with fake input", async ({ page }) => {
    await page.goto("/session?audio=silent&input=tap");
    await expect(page.getByTestId("start")).toBeVisible();
    expect(await page.evaluate(() => window.__clavisSession)).toBeUndefined();
    expect(await page.evaluate(() => window.__clavisFakeInput)).toBeUndefined();
  });
});
