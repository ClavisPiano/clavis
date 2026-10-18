import type { Page } from "@playwright/test";

/*
 * A stubbed Web MIDI keyboard for the HANDS specs (T5.3, T5.5): `navigator.requestMIDIAccess`
 * resolves to a fake with one keyboard, "kb-1", that the test plays through `window.__fakeMidi`.
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

/** Replace Web MIDI with a fake that has one keyboard plugged in, before the page loads. */
export async function stubMidi(page: Page): Promise<void> {
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
