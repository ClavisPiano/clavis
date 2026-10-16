import { expect, test, type Page } from "@playwright/test";

/*
 * Web MIDI input (T5.1). `navigator.requestMIDIAccess` is replaced by a fake with two keyboards
 * the test can play and plug in. Chromium has the real API; WebKit has none, which is the
 * "unsupported" case the second group covers with the API removed.
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

async function removeMidi(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Reflect.deleteProperty(Navigator.prototype, "requestMIDIAccess");
    Reflect.deleteProperty(navigator, "requestMIDIAccess");
  });
}

test.describe("MIDI keyboard", () => {
  test.setTimeout(90_000);

  test("a session item answered by a MIDI note is graded correctly", async ({ page }) => {
    await stubMidi(page);
    await page.goto("/session?input=midi&audio=silent&budget=90");
    await page.getByTestId("start").click();
    await page.getByTestId("continue").click(); // warm-up
    await page.getByTestId("continue").click(); // intro card

    await page.waitForFunction(() => window.__clavisSession?.phase === "listening-practice");
    await page.getByTestId("ready").click();
    await page.waitForFunction(() => window.__clavisSession?.phase === "listening-play");
    // Wait out the short gate after the example, then play the asked-for note on the keyboard.
    await page.waitForTimeout(400);
    const target = await page.evaluate(() => {
      const play = window.__clavisSession?.expected?.play;
      if (play?.kind !== "pitchClass") throw new Error("expected a played degree");
      return play.targetMidi;
    });
    await page.evaluate((midi) => {
      window.__fakeMidi?.send("kb-1", [0x90, midi, 96]);
      window.__fakeMidi?.send("kb-1", [0x80, midi, 0]);
    }, target);
    await expect(page.getByTestId("feedback")).toHaveAttribute("data-correct", "true");
  });

  test("a wrong MIDI note is graded wrong", async ({ page }) => {
    await stubMidi(page);
    await page.goto("/session?input=midi&audio=silent&budget=90");
    await page.getByTestId("start").click();
    await page.getByTestId("continue").click();
    await page.getByTestId("continue").click();
    await page.waitForFunction(() => window.__clavisSession?.phase === "listening-practice");
    await page.getByTestId("ready").click();
    await page.waitForFunction(() => window.__clavisSession?.phase === "listening-play");
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      const play = window.__clavisSession?.expected?.play;
      if (play?.kind !== "pitchClass") throw new Error("expected a played degree");
      window.__fakeMidi?.send("kb-1", [0x90, play.targetMidi + 1, 96]);
    });
    await page.getByTestId("done").click();
    await expect(page.getByTestId("feedback")).toHaveAttribute("data-correct", "false");
  });

  test("settings offer the MIDI keyboard, list devices and remember the choice", async ({
    page,
  }) => {
    await stubMidi(page);
    await page.goto("/settings");
    await expect(page.getByTestId("midi-device")).toHaveCount(0);
    await page.getByTestId("input-mode").selectOption("midi");
    const device = page.getByTestId("midi-device");
    await expect(device).toBeVisible();
    await expect(device.locator("option")).toHaveText([
      "All connected keyboards",
      "Fake Stage Piano",
    ]);

    // A keyboard plugged in later shows up.
    await page.evaluate(() => window.__fakeMidi?.plug("kb-2", "Fake Synth"));
    await expect(device.locator("option")).toHaveText([
      "All connected keyboards",
      "Fake Stage Piano",
      "Fake Synth",
    ]);

    await device.selectOption("kb-2");
    await page.getByTestId("save").click();
    await expect(page.getByTestId("saved")).toHaveText("Saved");

    await page.reload();
    await expect(page.getByTestId("input-mode")).toHaveValue("midi");
    await expect(page.getByTestId("midi-device")).toHaveValue("kb-2");
  });
});

test.describe("without Web MIDI", () => {
  test("settings hide the MIDI option", async ({ page }) => {
    await removeMidi(page);
    await page.goto("/settings");
    await expect(page.getByTestId("input-mode")).toBeVisible();
    await expect(page.getByTestId("input-mode").locator("option")).toHaveText([
      "Auto",
      "Microphone",
      "On-screen keyboard",
    ]);
  });

  test("a stored MIDI choice is ignored in settings", async ({ page }) => {
    await removeMidi(page);
    await page.addInitScript(() => {
      localStorage.setItem("clavisInput", "midi");
    });
    await page.goto("/settings");
    await expect(page.getByTestId("input-mode")).toHaveValue("auto");
  });
});
