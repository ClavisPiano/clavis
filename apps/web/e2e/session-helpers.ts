import { expect, type Page } from "@playwright/test";

/*
 * Shared by the session specs: answer fake-input sessions correctly and read the stored event log.
 * The page exposes window.__clavisSession and window.__clavisFakeInput in fake mode.
 */

/** Answer whatever the current listening phase expects, correctly. */
export async function answerCurrentPhase(page: Page): Promise<void> {
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
      if (play.kind === "choice") {
        // Choice items are answered with buttons, not notes.
        document.querySelector<HTMLElement>(`[data-testid="choice-${play.correct}"]`)?.click();
      } else if (play.kind === "pitchClass" || play.kind === "exactPitch") {
        fake.emitNote(play.targetMidi, { onsetMs: base });
      } else if (play.kind === "sequence") {
        play.midi.forEach((midi, i) => fake.emitNote(midi, { onsetMs: base + i * 400 }));
      } else if (play.kind === "line") {
        const beatMs = 60000 / play.tempoBpm;
        play.midi.forEach((midi, i) =>
          fake.emitNote(midi, { onsetMs: base + (play.onsetsBeats[i] ?? 0) * beatMs }),
        );
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
export async function runToSummary(page: Page): Promise<string[]> {
  const answered: string[] = [];
  const deadline = Date.now() + 100_000;
  while (Date.now() < deadline) {
    const state = await page.getByTestId("session").getAttribute("data-state");
    if (state === "summary") return answered;
    if (state === "error") throw new Error("session reached the error state");
    if (state === "orient" || state === "intro") {
      await page
        .getByTestId("continue")
        .click({ timeout: 2_000 })
        .catch(() => undefined);
    } else if (state === "feedback") {
      const next = page.getByTestId("next");
      // The session can move on by itself (auto-advance, or the budget running out on a slow
      // runner), so never block on a button that may have gone: try briefly, then re-check.
      if (await next.isVisible()) await next.click({ timeout: 2_000 }).catch(() => undefined);
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
export async function storedEventTypes(page: Page): Promise<string[]> {
  await page.goto("/dev/events");
  await expect(page.getByTestId("events")).toBeVisible();
  const texts = await page.getByTestId("event").locator("strong").allTextContents();
  return texts.reverse();
}
