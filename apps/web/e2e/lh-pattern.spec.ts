import { expect, test, type Page } from "@playwright/test";
import { expectNotationDrawn, seedLearner } from "./read-helpers";

/*
 * Left-hand chords (T5.3). A learner with the chord skill started plays a progression through a
 * stubbed Web MIDI keyboard (the same stub as midi.spec.ts) and is graded by alignment. Chords are
 * struck in real time, two seconds apart, as the written half notes at 60 bpm ask.
 */

declare global {
  interface Window {
    __fakeMidi?: {
      /** Send raw MIDI bytes from the keyboard `id`, stamped with performance.now(). */
      send(id: string, data: number[]): void;
      plug(id: string, name: string): void;
      unplug(id: string): void;
    };
  }
}

const HANDS = "hands.lh.triads.root";

async function stubMidi(page: Page): Promise<void> {
  await page.addInitScript(() => {
    class FakeInput extends EventTarget {
      type = "input";
      state = "connected";
      constructor(
        readonly id: string,
        readonly name: string,
      ) {
        super();
      }
    }
    const inputs = new Map<string, FakeInput>();
    const access = Object.assign(new EventTarget(), { inputs });
    const plug = (id: string, name: string): void => {
      inputs.set(id, new FakeInput(id, name));
      access.dispatchEvent(new Event("statechange"));
    };
    plug("kb-1", "Fake Stage Piano");
    Object.defineProperty(navigator, "requestMIDIAccess", {
      configurable: true,
      value: () => Promise.resolve(access),
    });
    window.__fakeMidi = {
      send(id, data) {
        const e = new Event("midimessage");
        Object.defineProperties(e, {
          data: { value: new Uint8Array(data) },
          timeStamp: { value: performance.now() },
        });
        inputs.get(id)?.dispatchEvent(e);
      },
      plug,
      unplug(id) {
        inputs.delete(id);
        access.dispatchEvent(new Event("statechange"));
      },
    };
  });
}

/** Click through the warm-up and skip any ear item until the chord item is waiting for an answer. */
async function skipToChordItem(page: Page): Promise<void> {
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
      if (kind === "chordLine") return;
      await click("skip");
    } else await page.waitForTimeout(100);
  }
  throw new Error("no chord item appeared");
}

/** The chord tones the current item asks for, read from the test hook. */
async function currentChords(page: Page): Promise<number[][]> {
  return await page.evaluate(() => {
    const play = window.__clavisSession?.expected?.play;
    if (play?.kind !== "chordLine") throw new Error("expected a chord line");
    return play.chords.map((c) => c.midi);
  });
}

/** Strike each chord (all its tones at once, then released), two seconds apart. */
async function playChords(
  page: Page,
  chords: number[][],
  change?: (midi: number, chord: number, tone: number) => number,
): Promise<void> {
  await page.waitForFunction(() => window.__clavisSession?.phase === "listening-play");
  for (const [ci, chord] of chords.entries()) {
    await page.evaluate(
      ({ tones }) => {
        for (const midi of tones) window.__fakeMidi?.send("kb-1", [0x90, midi, 96]);
      },
      { tones: chord.map((m, ti) => change?.(m, ci, ti) ?? m) },
    );
    await page.waitForTimeout(150);
    await page.evaluate(
      ({ tones }) => {
        for (const midi of tones) window.__fakeMidi?.send("kb-1", [0x80, midi, 0]);
      },
      { tones: chord.map((m, ti) => change?.(m, ci, ti) ?? m) },
    );
    if (ci < chords.length - 1) await page.waitForTimeout(1850);
  }
}

async function startSession(page: Page): Promise<void> {
  await stubMidi(page);
  await seedLearner(page, [{ nodeId: HANDS, keyFamily: "A" }], { newItemsPerDay: 15 });
  await page.goto("/session?input=midi&audio=silent&budget=420&headphones=yes");
  await page.getByTestId("start").click();
  await skipToChordItem(page);
}

test.describe("Left-hand chords on a MIDI keyboard", () => {
  test.setTimeout(120_000);
  test.skip(({ browserName }) => browserName !== "chromium", "Web MIDI is a Chromium feature");

  test("shows the chords on the bass staff and passes when they are played", async ({ page }) => {
    await startSession(page);
    await expectNotationDrawn(page);
    await expect(page.getByTestId("notation-slot")).toHaveAttribute("data-block", "apply");
    await expect(page.getByTestId("prompt")).toHaveText("Play these chords with your left hand");
    const labels = page.getByTestId("chord-labels");
    await expect(labels).toBeVisible();
    // Four chords, the first of them the home chord.
    await expect(labels.locator(".chord")).toHaveCount(4);
    await expect(labels.locator(".chord").first()).toContainText("I");

    await playChords(page, await currentChords(page));
    const feedback = page.getByTestId("feedback");
    await expect(feedback).toHaveAttribute("data-correct", "true", { timeout: 15_000 });
    await expect(page.getByTestId("result")).toHaveText("Correct");
  });

  test("names the wrong tone when a chord is played wrong", async ({ page }) => {
    await startSession(page);
    const chords = await currentChords(page);
    // The root of the second chord, a semitone low.
    await playChords(page, chords, (midi, chord, tone) =>
      chord === 1 && tone === 0 ? midi - 1 : midi,
    );
    const feedback = page.getByTestId("feedback");
    await expect(feedback).toHaveAttribute("data-correct", "false", { timeout: 15_000 });
    await expect(page.getByTestId("issues")).toContainText(
      /You played [A-G][#b]? instead of [A-G][#b]? in the \w+ chord\./,
    );
    await expect(page.getByTestId("answer")).toContainText("The chords were");
  });
});
