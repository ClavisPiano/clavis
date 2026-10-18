import { expect, test, type Page } from "@playwright/test";
import { stubMidi } from "./midi-helpers";
import { expectNotationDrawn, seedLearner } from "./read-helpers";

/*
 * Hands together over block chords (T5.5). A learner whose left-hand chords are placed as mastered
 * has started hands.coord.basic, and plays a four-bar item with both hands through a stubbed Web
 * MIDI keyboard: a whole-note chord per bar in the left hand and quarter notes in the right, in
 * real time at the written 60 bpm. It is graded as a performance.
 */

const COORD = "hands.coord.basic";

interface Note {
  id: string;
  midi: number;
  onsetBeats: number;
  durationBeats: number;
}

/** Click through the warm-up and skip anything else until the two-hand item waits for an answer. */
async function skipToCoordItem(page: Page): Promise<void> {
  const deadline = Date.now() + 60_000;
  const click = async (testId: string): Promise<void> => {
    await page
      .getByTestId(testId)
      .click({ timeout: 1_000 })
      .catch(() => undefined);
  };
  while (Date.now() < deadline) {
    const state = await page.getByTestId("session").getAttribute("data-state");
    if (state === "error" || state === "summary") throw new Error(`session ended early: ${state}`);
    if (state === "orient" || state === "intro") await click("continue");
    else if (state === "feedback") await click("next");
    else if (state === "listening") {
      const kind = await page.evaluate(() => window.__clavisSession?.expected?.play?.kind);
      if (kind === "performance") return;
      await click("skip");
    } else await page.waitForTimeout(100);
  }
  throw new Error("no hands-together item appeared");
}

/** Every note of both hands the current item asks for, read from the test hook. */
async function currentNotes(page: Page): Promise<{ notes: Note[]; tempoBpm: number }> {
  return await page.evaluate(() => {
    const play = window.__clavisSession?.expected?.play;
    if (play?.kind !== "performance") throw new Error("expected a performance");
    return { notes: play.notes, tempoBpm: play.tempoBpm };
  });
}

/**
 * Play the notes in real time, scheduled in the page so the timing does not depend on round trips:
 * each key goes down at its onset and up shortly before its written length ends. Resolves when the
 * last key is up. `change` alters a note's pitch.
 */
async function performNotes(
  page: Page,
  played: { notes: Note[]; tempoBpm: number },
  change?: (n: Note) => number,
): Promise<void> {
  await page.waitForFunction(() => window.__clavisSession?.phase === "listening-play");
  const keys = played.notes.map((n) => ({ ...n, midi: change?.(n) ?? n.midi }));
  await page.evaluate(
    async ({ keys, beatMs }) => {
      const t0 = performance.now() + 50;
      let end = t0;
      for (const k of keys) {
        const down = t0 + k.onsetBeats * beatMs;
        const up = down + k.durationBeats * beatMs * 0.85;
        end = Math.max(end, up);
        setTimeout(() => window.__fakeMidi?.send("kb-1", [0x90, k.midi, 90]), down - t0);
        setTimeout(() => window.__fakeMidi?.send("kb-1", [0x80, k.midi, 0]), up - t0);
      }
      await new Promise((resolve) => setTimeout(resolve, end - t0 + 50));
    },
    { keys, beatMs: 60_000 / played.tempoBpm },
  );
}

async function startSession(page: Page): Promise<void> {
  await stubMidi(page);
  await seedLearner(page, [{ nodeId: COORD, keyFamily: "A" }], {
    newItemsPerDay: 15,
    placedMastered: ["hands.lh.triads.root"],
  });
  await page.goto("/session?input=midi&audio=silent&budget=420&headphones=yes");
  await page.getByTestId("start").click();
  await skipToCoordItem(page);
}

test.describe("Hands together on a MIDI keyboard", () => {
  test.setTimeout(150_000);
  test.skip(({ browserName }) => browserName !== "chromium", "Web MIDI is a Chromium feature");

  test("shows the grand staff with chords and hands, and passes a two-hand performance", async ({
    page,
  }) => {
    await startSession(page);
    await expectNotationDrawn(page);
    await expect(page.getByTestId("notation-slot")).toHaveAttribute("data-block", "apply");
    await expect(page.getByTestId("prompt")).toHaveText("Play this with both hands");
    await expect(page.getByTestId("hands-hint")).toHaveText(
      "Right hand: top staff. Left hand: bottom staff.",
    );
    const labels = page.getByTestId("chord-labels");
    await expect(labels.locator(".chord")).toHaveCount(4);
    await expect(labels.locator(".chord").first()).toContainText("I");

    const played = await currentNotes(page);
    expect(played.notes).toHaveLength(16 + 12);
    await performNotes(page, played);
    await expect(page.getByTestId("feedback")).toHaveAttribute("data-correct", "true", {
      timeout: 15_000,
    });
    await expect(page.getByTestId("result")).toHaveText("Correct");
  });

  test("names the bar and hand of a wrong note", async ({ page }) => {
    await startSession(page);
    const played = await currentNotes(page);
    // The root of the left hand's third chord (n19.0), a semitone low.
    await performNotes(page, played, (n) => (n.id === "n19.0" ? n.midi - 1 : n.midi));
    await expect(page.getByTestId("feedback")).toHaveAttribute("data-correct", "false", {
      timeout: 15_000,
    });
    await expect(page.getByTestId("issues")).toContainText(
      /Bar 3: LH played [A-G][#b]?\d instead of [A-G][#b]?\d/,
    );
  });
});
