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

/** One note of a two-hand performance, as the test hook shows it (T5.6). */
export interface PerformanceNote {
  id: string;
  midi: number;
  onsetBeats: number;
  durationBeats: number;
  hand: "lh" | "rh";
}

/** Every note of both hands the current performance item asks for, read from the test hook. */
export async function currentPerformance(
  page: Page,
): Promise<{ notes: PerformanceNote[]; tempoBpm: number }> {
  return await page.evaluate(() => {
    const play = window.__clavisSession?.expected?.play;
    if (play?.kind !== "performance") throw new Error("expected a performance");
    return { notes: play.notes, tempoBpm: play.tempoBpm };
  });
}

/**
 * Play a performance in real time once the item listens, scheduled in the page so the timing does
 * not depend on round trips: each key goes down at its onset and up shortly before its written
 * length ends. Resolves when the last key is up. `change` alters a note's pitch.
 */
export async function playPerformance(
  page: Page,
  played: { notes: PerformanceNote[]; tempoBpm: number },
  change?: (n: PerformanceNote) => number,
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
