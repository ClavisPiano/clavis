import { describe, expect, it } from "vitest";
import type { NoteEvent } from "@clavis/core";
import { CompositeInputAdapter } from "./composite-adapter.js";
import { FakeInputAdapter } from "./fake-adapter.js";
import { TapInputAdapter } from "./tap-adapter.js";

const keys = (): TapInputAdapter =>
  new TapInputAdapter({ getContext: () => ({ currentTime: 1 }), now: () => 1000 });

describe("CompositeInputAdapter", () => {
  it("delivers notes from the main input and from the keys, each with its own source", async () => {
    const main = new FakeInputAdapter({ source: "mic" });
    const tap = keys();
    const both = new CompositeInputAdapter(main, tap);
    await both.start();
    const heard: NoteEvent[] = [];
    both.onNote((n) => heard.push(n));
    main.emitNote({ pitch: 60, onsetMs: 10 });
    tap.press(62, 1000);
    expect(heard.map((n) => [n.pitch, n.source])).toEqual([
      [60, "mic"],
      [62, "tap"],
    ]);
    expect(both.source).toBe("mic");
  });

  it("gates both inputs together", async () => {
    const main = new FakeInputAdapter({ source: "mic" });
    const tap = keys();
    const both = new CompositeInputAdapter(main, tap);
    await both.start();
    const heard: NoteEvent[] = [];
    both.onNote((n) => heard.push(n));
    both.pause();
    main.emitNote({ pitch: 60, onsetMs: 10 });
    tap.press(62, 1000);
    expect(heard).toEqual([]);
    both.resume();
    tap.press(64, 1000);
    expect(heard.map((n) => n.pitch)).toEqual([64]);
  });

  it("stops listening to both when unsubscribed", async () => {
    const main = new FakeInputAdapter({ source: "mic" });
    const tap = keys();
    const both = new CompositeInputAdapter(main, tap);
    await both.start();
    const heard: NoteEvent[] = [];
    const off = both.onNote((n) => heard.push(n));
    off();
    main.emitNote({ pitch: 60, onsetMs: 10 });
    tap.press(62, 1000);
    expect(heard).toEqual([]);
  });

  it("passes the expected register to the main input only", () => {
    const main = new FakeInputAdapter({ source: "mic" });
    const both = new CompositeInputAdapter(main, keys());
    both.setExpectedRange({ low: 40, high: 60 });
    expect(main.expectedRange).toEqual({ low: 40, high: 60 });
  });
});
