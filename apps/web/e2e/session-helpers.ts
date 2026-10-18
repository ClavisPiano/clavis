import { expect, type Page } from "@playwright/test";

/*
 * Shared by the session specs: answer fake-input sessions correctly and read the stored event log.
 * The page exposes window.__clavisSession and window.__clavisFakeInput in fake mode.
 */

/**
 * Answer whatever the current listening phase expects, correctly. With `wrongAt`, that note of a
 * sequence or line is a semitone off.
 */
export async function answerCurrentPhase(page: Page, o: { wrongAt?: number } = {}): Promise<void> {
  await page.evaluate((wrongAt) => {
    const session = window.__clavisSession;
    const fake = window.__clavisFakeInput;
    const expected = session?.expected;
    if (!session || !fake || !expected) return;
    // Answers start after the gate (stimulus end plus tail, or phase start plus tail).
    const base = fake.nowMs() + 300;
    if (session.phase === "listening-play" && expected.play) {
      const play = expected.play;
      if (play.kind === "choice") {
        // Choice items are answered with buttons, not notes.
        document.querySelector<HTMLElement>(`[data-testid="choice-${play.correct}"]`)?.click();
      } else if (play.kind === "pitchClass" || play.kind === "exactPitch") {
        fake.emitNote(play.targetMidi, { onsetMs: base });
      } else if (play.kind === "sequence") {
        play.midi.forEach((midi, i) =>
          fake.emitNote(midi + (i === wrongAt ? 1 : 0), { onsetMs: base + i * 400 }),
        );
      } else if (play.kind === "line") {
        const beatMs = 60000 / play.tempoBpm;
        play.midi.forEach((midi, i) =>
          fake.emitNote(midi + (i === wrongAt ? 1 : 0), {
            onsetMs: base + (play.onsetsBeats[i] ?? 0) * beatMs,
          }),
        );
      } else if (play.kind === "chordLine") {
        const beatMs = 60000 / play.tempoBpm;
        for (const c of play.chords) {
          for (const midi of c.midi) fake.emitNote(midi, { onsetMs: base + c.onsetBeats * beatMs });
        }
      } else if (play.kind === "performance") {
        const beatMs = 60000 / play.tempoBpm;
        for (const n of play.notes)
          fake.emitNote(n.midi, { onsetMs: base + n.onsetBeats * beatMs });
      } else {
        const beatMs = 60000 / play.tempoBpm;
        for (const beat of play.onsetsBeats) {
          fake.emitNote(play.pitch ?? 60, { onsetMs: base + beat * beatMs });
        }
      }
    }
  }, o.wrongAt);
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
      if (phase === "listening-practice" || phase === "listening-cue") {
        // Degree items open with a practice step, and by-ear items with the sing or hum cue:
        // nothing is marked until Ready.
        await page
          .getByTestId("ready")
          .click({ timeout: 2_000 })
          .catch(() => undefined);
        continue;
      }
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
