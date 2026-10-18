import { expect, test, type Page } from "@playwright/test";
import { expectNotationDrawn, seedLearner } from "./read-helpers";

/*
 * Grand-staff lines (T5.11). A learner with the two-staff reading skill started gets a line as the
 * Read block's closing item, reads it from the grand staff and plays it through a stubbed Web MIDI
 * keyboard (the same stub as midi.spec.ts and lh-pattern.spec.ts), in real time at the written
 * tempo, both hands together.
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

const TWO_LINE = "read.grand.2line";

interface LineNote {
  midi: number;
  onsetBeats: number;
  hand: "lh" | "rh";
}

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

/** Click through the warm-up and skip any other item until the line is waiting for an answer. */
async function skipToLine(page: Page): Promise<void> {
  const deadline = Date.now() + 90_000;
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
  throw new Error("no grand-staff line appeared");
}

/** The notes the current line asks for, read from the test hook. */
async function currentLine(page: Page): Promise<{ notes: LineNote[]; tempoBpm: number }> {
  return await page.evaluate(() => {
    const play = window.__clavisSession?.expected?.play;
    if (play?.kind !== "performance") throw new Error("expected a performance");
    return {
      notes: play.notes.map((n) => ({ midi: n.midi, onsetBeats: n.onsetBeats, hand: n.hand })),
      tempoBpm: play.tempoBpm,
    };
  });
}

/** Play every note at its written time (note on, then off 150 ms later), from inside the page. */
async function playLine(page: Page, notes: readonly LineNote[], tempoBpm: number): Promise<void> {
  await page.waitForFunction(() => window.__clavisSession?.phase === "listening-play");
  await page.evaluate(
    async ({ notes, beatMs }) => {
      const send = (data: number[]): void => window.__fakeMidi?.send("kb-1", data);
      const timers = notes.map(
        (n) =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              send([0x90, n.midi, 90]);
              setTimeout(() => {
                send([0x80, n.midi, 0]);
                resolve();
              }, 150);
            }, n.onsetBeats * beatMs);
          }),
      );
      await Promise.all(timers);
    },
    { notes, beatMs: 60000 / tempoBpm },
  );
}

async function startSession(page: Page): Promise<void> {
  await stubMidi(page);
  // The bass reading chain is placed, so the two-staff node is unlocked and can be introduced.
  await seedLearner(page, [{ nodeId: TWO_LINE, keyFamily: "A" }], {
    newItemsPerDay: 15,
    placedMastered: ["read.bass.landmarks", "read.bass.steps", "read.bass.intervals"],
  });
  await page.goto("/session?input=midi&audio=silent&budget=420&headphones=yes");
  await page.getByTestId("start").click();
  await skipToLine(page);
}

test.describe("Grand-staff lines on a MIDI keyboard", () => {
  test.setTimeout(150_000);
  test.skip(({ browserName }) => browserName !== "chromium", "Web MIDI is a Chromium feature");

  test("closes the Read block with a line for both hands and passes it", async ({ page }) => {
    await startSession(page);
    await expectNotationDrawn(page);
    await expect(page.getByTestId("notation-slot")).toHaveAttribute("data-block", "read");
    await expect(page.getByTestId("prompt")).toHaveText("Play this with both hands");
    const { notes, tempoBpm } = await currentLine(page);
    expect(new Set(notes.map((n) => n.hand))).toEqual(new Set(["lh", "rh"]));

    await playLine(page, notes, tempoBpm);
    const feedback = page.getByTestId("feedback");
    await expect(feedback).toHaveAttribute("data-correct", "true", { timeout: 15_000 });
    await expect(page.getByTestId("result")).toHaveText("Correct");
  });

  test("names the bar and hand of a wrong note", async ({ page }) => {
    await startSession(page);
    const { notes, tempoBpm } = await currentLine(page);
    // The first right-hand note of bar 2, a semitone high.
    const target = notes.findIndex((n) => n.hand === "rh" && n.onsetBeats >= 4);
    const played = notes.map((n, i) => (i === target ? { ...n, midi: n.midi + 1 } : n));
    await playLine(page, played, tempoBpm);
    const feedback = page.getByTestId("feedback");
    await expect(feedback).toHaveAttribute("data-correct", "false", { timeout: 15_000 });
    await expect(page.getByTestId("issues")).toContainText(/Bar 2: RH/);
  });
});
