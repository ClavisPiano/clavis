import type { NoteEvent, PitchFrame } from "@clavis/core";
import { describe, expect, it } from "vitest";
import { FakeInputAdapter, ManualClock } from "./fake-adapter";
import { MicInputAdapter, type MicSourceLike } from "./mic-adapter";
import { TapInputAdapter } from "./tap-adapter";
import { eventTimeToContextMs } from "./time";
import type { CaptureContext, NotePhase } from "../mic/mic-source";

describe("eventTimeToContextMs", () => {
  it("anchors on getOutputTimestamp", () => {
    // Context was at 2 s when performance.now() read 10000 ms. An event at 10250 ms is 250 ms later.
    const ms = eventTimeToContextMs(10250, {
      outputTimestamp: { contextTime: 2, performanceTime: 10000 },
      contextNowMs: 9999,
    });
    expect(ms).toBe(2250);
  });

  it("handles events before the anchor", () => {
    const ms = eventTimeToContextMs(9900, {
      outputTimestamp: { contextTime: 2, performanceTime: 10000 },
      contextNowMs: 0,
    });
    expect(ms).toBe(1900);
  });

  it.each([
    ["missing", undefined],
    ["empty", {}],
    ["zero performanceTime", { contextTime: 0, performanceTime: 0 }],
    ["NaN", { contextTime: Number.NaN, performanceTime: 5 }],
  ])("falls back to context now minus event age when the timestamp is %s", (_name, ts) => {
    const ms = eventTimeToContextMs(990, {
      outputTimestamp: ts,
      contextNowMs: 5000,
      performanceNowMs: 1000,
    });
    expect(ms).toBe(4990);
  });

  it("falls back to context now with no performance clock, and never goes negative", () => {
    expect(eventTimeToContextMs(1, { contextNowMs: 700 })).toBe(700);
    expect(eventTimeToContextMs(0, { contextNowMs: 5, performanceNowMs: 1000 })).toBe(0);
  });

  it("treats a future event timestamp as now in the fallback", () => {
    expect(eventTimeToContextMs(2000, { contextNowMs: 500, performanceNowMs: 1000 })).toBe(500);
  });
});

describe("FakeInputAdapter", () => {
  it("replays the script in atMs order at the right times", async () => {
    const clock = new ManualClock(1000);
    const fake = new FakeInputAdapter({
      clock,
      source: "tap",
      script: [
        { atMs: 300, note: { pitch: 64 } },
        { atMs: 100, note: { pitch: 60 } },
        { atMs: 100, note: { pitch: 62 } },
        { atMs: 200, frame: { hz: 440, confidence: 0.9, atMs: 1200 } },
      ],
    });
    const notes: NoteEvent[] = [];
    const frames: PitchFrame[] = [];
    fake.onNote((n) => notes.push(n));
    fake.onFrame((f) => frames.push(f));
    await fake.start();

    clock.advance(99);
    expect(notes).toEqual([]);
    clock.advance(1);
    expect(notes.map((n) => n.pitch)).toEqual([60, 62]);
    expect(notes[0]).toEqual({ pitch: 60, onsetMs: 1100, confidence: 1, source: "tap" });
    clock.advance(100);
    expect(frames).toHaveLength(1);
    expect(notes).toHaveLength(2);
    clock.advance(100);
    expect(notes.map((n) => n.pitch)).toEqual([60, 62, 64]);
    expect(notes[2]?.onsetMs).toBe(1300);
  });

  it("anchors the script on anchorMs", async () => {
    const clock = new ManualClock(5000);
    const fake = new FakeInputAdapter({
      clock,
      anchorMs: 5100,
      script: [{ atMs: 50, note: { pitch: 61 } }],
    });
    const notes: NoteEvent[] = [];
    fake.onNote((n) => notes.push(n));
    await fake.start();
    clock.advance(149);
    expect(notes).toEqual([]);
    clock.advance(1);
    expect(notes[0]?.onsetMs).toBe(5150);
  });

  it("drops events while paused, delivers again after resume", async () => {
    const clock = new ManualClock(0);
    const fake = new FakeInputAdapter({
      clock,
      script: [
        { atMs: 10, note: { pitch: 60 } },
        { atMs: 20, note: { pitch: 62 } },
      ],
    });
    const notes: NoteEvent[] = [];
    fake.onNote((n) => notes.push(n));
    await fake.start();
    fake.pause();
    clock.advance(15);
    expect(notes).toEqual([]);
    expect(fake.emitNote({ pitch: 1 })).toBeUndefined();
    fake.resume();
    clock.advance(10);
    expect(notes.map((n) => n.pitch)).toEqual([62]);
  });

  it("unsubscribe stops delivery and stop cancels pending steps", async () => {
    const clock = new ManualClock(0);
    const fake = new FakeInputAdapter({
      clock,
      script: [{ atMs: 10, note: {} }],
    });
    const a: NoteEvent[] = [];
    const b: NoteEvent[] = [];
    const offA = fake.onNote((n) => a.push(n));
    fake.onNote((n) => b.push(n));
    offA();
    fake.emitNote({ pitch: 70 });
    expect(a).toEqual([]);
    expect(b).toHaveLength(1);
    await fake.start();
    fake.stop();
    clock.advance(100);
    expect(b).toHaveLength(1);
  });

  it("emitNote fills defaults from the clock", () => {
    const fake = new FakeInputAdapter({ clock: new ManualClock(42) });
    expect(fake.emitNote({ pitch: 65 })).toEqual({
      pitch: 65,
      onsetMs: 42,
      confidence: 1,
      source: "mic",
    });
    expect(fake.emitFrame({ hz: null, confidence: 0 })).toEqual({
      hz: null,
      confidence: 0,
      atMs: 42,
    });
  });
});

describe("TapInputAdapter", () => {
  const ctx = {
    currentTime: 3,
    getOutputTimestamp: () => ({ contextTime: 2, performanceTime: 10000 }),
  };

  it("emits tap NoteEvents on the AudioContext clock", async () => {
    const tap = new TapInputAdapter({ getContext: () => ctx, now: () => 10400 });
    const notes: NoteEvent[] = [];
    tap.onNote((n) => notes.push(n));
    await tap.start();
    tap.press(60, 10250);
    expect(notes).toEqual([{ pitch: 60, onsetMs: 2250, confidence: 1, source: "tap" }]);
    expect(tap.release(60, 10500)).toBe(2500);
    expect(tap.release(60, 10600)).toBeUndefined();
  });

  it("falls back to currentTime without a context timestamp", async () => {
    const tap = new TapInputAdapter({
      getContext: () => ({ currentTime: 1.5 }),
      now: () => 500,
    });
    const notes: NoteEvent[] = [];
    tap.onNote((n) => notes.push(n));
    await tap.start();
    tap.press(61, 480);
    expect(notes[0]?.onsetMs).toBe(1480);
  });

  it("drops presses before start, while paused and after stop", async () => {
    const tap = new TapInputAdapter({ getContext: () => ctx, now: () => 10000 });
    const notes: NoteEvent[] = [];
    tap.onNote((n) => notes.push(n));
    tap.press(60, 10000);
    await tap.start();
    tap.pause();
    tap.press(60, 10000);
    tap.resume();
    tap.press(62, 10000);
    tap.stop();
    tap.press(64, 10000);
    expect(notes.map((n) => n.pitch)).toEqual([62]);
  });

  it("never calls frame listeners and supports unsubscribe", async () => {
    const tap = new TapInputAdapter({ getContext: () => undefined, now: () => 0 });
    const frames: PitchFrame[] = [];
    const off = tap.onFrame((f) => frames.push(f));
    off();
    await tap.start();
    tap.press(60, 0);
    expect(frames).toEqual([]);
  });
});

describe("MicInputAdapter", () => {
  function fakeMic() {
    const noteListeners = new Set<(n: NoteEvent, p: NotePhase) => void>();
    const frameListeners = new Set<(f: PitchFrame) => void>();
    const calls: string[] = [];
    const source: MicSourceLike = {
      start: () => {
        calls.push("start");
        return Promise.resolve();
      },
      stop: () => {
        calls.push("stop");
        return Promise.resolve();
      },
      pause: () => calls.push("pause"),
      resume: () => calls.push("resume"),
      setExpectedRange: (range) => calls.push(`range:${JSON.stringify(range)}`),
      onNote: (cb) => {
        noteListeners.add(cb);
        return () => {
          noteListeners.delete(cb);
        };
      },
      onFrame: (cb) => {
        frameListeners.add(cb);
        return () => {
          frameListeners.delete(cb);
        };
      },
    };
    return {
      source,
      calls,
      note: (n: NoteEvent, p: NotePhase) => {
        for (const l of noteListeners) l(n, p);
      },
      frame: (f: PitchFrame) => {
        for (const l of frameListeners) l(f);
      },
    };
  }

  const context = {} as CaptureContext;
  const base: NoteEvent = { pitch: 60, onsetMs: 100, confidence: 0.9, source: "mic" };

  it("forwards the start phase only, and gates while paused", async () => {
    const mic = fakeMic();
    const adapter = new MicInputAdapter({ source: mic.source, getContext: () => context });
    const notes: NoteEvent[] = [];
    const frames: PitchFrame[] = [];
    adapter.onNote((n) => notes.push(n));
    adapter.onFrame((f) => frames.push(f));
    await adapter.start();
    mic.note(base, "start");
    mic.note({ ...base, offsetMs: 400 }, "end");
    expect(notes).toEqual([base]);

    adapter.pause();
    mic.note({ ...base, pitch: 62 }, "start");
    mic.frame({ hz: 440, confidence: 1, atMs: 1 });
    expect(notes).toHaveLength(1);
    expect(frames).toEqual([]);
    adapter.resume();
    mic.frame({ hz: 440, confidence: 1, atMs: 2 });
    expect(frames).toHaveLength(1);

    adapter.stop();
    mic.note(base, "start");
    expect(notes).toHaveLength(1);
    expect(mic.calls).toEqual(["start", "pause", "resume", "stop"]);
  });

  it("forwards the expected range to the mic source, before and after start", async () => {
    const mic = fakeMic();
    const adapter = new MicInputAdapter({ source: mic.source, getContext: () => context });
    adapter.setExpectedRange({ low: 36, high: 64 });
    await adapter.start();
    adapter.setExpectedRange(null);
    expect(mic.calls).toEqual(['range:{"low":36,"high":64}', "start", "range:null"]);
  });

  it("tolerates a source without setExpectedRange", () => {
    const mic = fakeMic();
    const bare: MicSourceLike = { ...mic.source };
    delete bare.setExpectedRange;
    const adapter = new MicInputAdapter({ source: bare, getContext: () => context });
    expect(() => {
      adapter.setExpectedRange({ low: 36, high: 64 });
    }).not.toThrow();
  });
});

describe("setExpectedRange on the other adapters", () => {
  it("the fake records every call, and tap ignores it", () => {
    const fake = new FakeInputAdapter();
    expect(fake.expectedRange).toBeNull();
    fake.setExpectedRange({ low: 36, high: 64 });
    fake.setExpectedRange(null);
    expect(fake.expectedRangeCalls).toEqual([{ low: 36, high: 64 }, null]);
    expect(fake.expectedRange).toBeNull();
    const tap = new TapInputAdapter({ getContext: () => undefined });
    expect(() => {
      tap.setExpectedRange();
    }).not.toThrow();
  });
});
