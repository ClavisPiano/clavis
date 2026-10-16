import type { NoteEvent } from "@clavis/core";
import { describe, expect, it } from "vitest";
import {
  MidiAdapter,
  isMidiSupported,
  type MidiAccessLike,
  type MidiInputLike,
  type MidiMessageEventLike,
} from "./midi";

class FakeInput extends EventTarget {
  readonly type = "input";
  state = "connected";
  listenerCount = 0;
  constructor(
    readonly id: string,
    readonly name: string = id,
  ) {
    super();
  }
  send(data: number[], timeStamp = 0): void {
    const e = new Event("midimessage") as Event & MidiMessageEventLike;
    Object.defineProperties(e, {
      data: { value: new Uint8Array(data) },
      timeStamp: { value: timeStamp },
    });
    this.dispatchEvent(e);
  }
  override addEventListener(
    type: string,
    l: EventListenerOrEventListenerObject | null,
    o?: boolean | AddEventListenerOptions,
  ): void {
    this.listenerCount++;
    super.addEventListener(type, l, o);
  }
  override removeEventListener(
    type: string,
    l: EventListenerOrEventListenerObject | null,
    o?: boolean | EventListenerOptions,
  ): void {
    this.listenerCount--;
    super.removeEventListener(type, l, o);
  }
}

class FakeAccess extends EventTarget {
  readonly map = new Map<string, FakeInput>();
  statechangeListeners = 0;
  get inputs() {
    return {
      forEach: (cb: (i: MidiInputLike) => void) => {
        this.map.forEach((i) => {
          cb(i as unknown as MidiInputLike);
        });
      },
    };
  }
  override addEventListener(
    type: string,
    l: EventListenerOrEventListenerObject | null,
    o?: boolean | AddEventListenerOptions,
  ): void {
    if (type === "statechange") this.statechangeListeners++;
    super.addEventListener(type, l, o);
  }
  override removeEventListener(
    type: string,
    l: EventListenerOrEventListenerObject | null,
    o?: boolean | EventListenerOptions,
  ): void {
    if (type === "statechange") this.statechangeListeners--;
    super.removeEventListener(type, l, o);
  }
  plug(input: FakeInput): void {
    this.map.set(input.id, input);
    this.dispatchEvent(new Event("statechange"));
  }
  unplug(id: string): void {
    this.map.delete(id);
    this.dispatchEvent(new Event("statechange"));
  }
}

function setup(opts: { channel?: number; inputId?: string; inputs?: FakeInput[] } = {}) {
  const access = new FakeAccess();
  for (const i of opts.inputs ?? [new FakeInput("a")]) access.map.set(i.id, i);
  const adapter = new MidiAdapter({
    requestMIDIAccess: () => Promise.resolve(access as unknown as MidiAccessLike),
    getContext: () => ({
      currentTime: 2,
      getOutputTimestamp: () => ({ contextTime: 2, performanceTime: 10000 }),
    }),
    now: () => 10000,
    ...(opts.channel === undefined ? {} : { channel: opts.channel }),
    ...(opts.inputId === undefined ? {} : { inputId: opts.inputId }),
  });
  const notes: NoteEvent[] = [];
  adapter.onNote((n) => notes.push(n));
  return { access, adapter, notes };
}

describe("MidiAdapter", () => {
  it("maps note on to a midi NoteEvent with velocity and exact confidence", async () => {
    const { access, adapter, notes } = setup();
    await adapter.start();
    access.map.get("a")?.send([0x90, 60, 100], 10250);
    expect(notes).toEqual([
      { pitch: 60, onsetMs: 2250, velocity: 100, confidence: 1, source: "midi" },
    ]);
  });

  it("treats note on with velocity 0 and note off as releases", async () => {
    const { access, adapter, notes } = setup();
    const releases: { pitch: number; offsetMs: number }[] = [];
    adapter.onRelease((r) => releases.push(r));
    await adapter.start();
    const input = access.map.get("a");
    input?.send([0x90, 60, 90], 10000);
    input?.send([0x90, 60, 0], 10100);
    input?.send([0x90, 62, 90], 10200);
    input?.send([0x80, 62, 64], 10400);
    input?.send([0x80, 64, 64], 10500);
    expect(notes.map((n) => n.pitch)).toEqual([60, 62]);
    expect(releases).toEqual([
      { pitch: 60, offsetMs: 2100 },
      { pitch: 62, offsetMs: 2400 },
    ]);
  });

  it("ignores controllers, short messages and null data", async () => {
    const { access, adapter, notes } = setup();
    await adapter.start();
    const input = access.map.get("a");
    input?.send([0xb0, 64, 127]);
    input?.send([0x90, 60]);
    input?.dispatchEvent(Object.assign(new Event("midimessage"), { data: null }));
    expect(notes).toEqual([]);
  });

  it("filters by channel (1-16)", async () => {
    const { access, adapter, notes } = setup({ channel: 2 });
    await adapter.start();
    access.map.get("a")?.send([0x90, 60, 80]);
    access.map.get("a")?.send([0x91, 62, 80]);
    expect(notes.map((n) => n.pitch)).toEqual([62]);
  });

  it("drops notes while paused and resumes", async () => {
    const { access, adapter, notes } = setup();
    await adapter.start();
    adapter.pause();
    access.map.get("a")?.send([0x90, 60, 80]);
    adapter.resume();
    access.map.get("a")?.send([0x90, 62, 80]);
    expect(notes.map((n) => n.pitch)).toEqual([62]);
  });

  it("listens to one input by id, or to all", async () => {
    const a = new FakeInput("a");
    const b = new FakeInput("b");
    const one = setup({ inputs: [a, b], inputId: "b" });
    await one.adapter.start();
    a.send([0x90, 60, 80]);
    b.send([0x90, 62, 80]);
    expect(one.notes.map((n) => n.pitch)).toEqual([62]);
    expect(one.adapter.listInputs().map((i) => i.id)).toEqual(["a", "b"]);
    one.adapter.setInput(undefined);
    a.send([0x90, 64, 80]);
    expect(one.notes.map((n) => n.pitch)).toEqual([62, 64]);
    one.adapter.setInput("a");
    b.send([0x90, 65, 80]);
    expect(one.notes).toHaveLength(2);
  });

  it("attaches hot-plugged inputs and detaches removed ones", async () => {
    const { access, adapter, notes } = setup({ inputs: [] });
    await adapter.start();
    const late = new FakeInput("late");
    access.plug(late);
    expect(late.listenerCount).toBe(1);
    late.send([0x90, 67, 80]);
    expect(notes.map((n) => n.pitch)).toEqual([67]);
    access.unplug("late");
    expect(late.listenerCount).toBe(0);
    late.send([0x90, 69, 80]);
    expect(notes).toHaveLength(1);
  });

  it("reports the connected inputs on start and on hot-plug", async () => {
    const { access, adapter } = setup({ inputs: [new FakeInput("a", "Piano")] });
    const seen: string[][] = [];
    adapter.onDevicesChanged((d) => seen.push(d.map((x) => x.name)));
    await adapter.start();
    access.plug(new FakeInput("b", "Synth"));
    access.unplug("a");
    expect(seen).toEqual([["Piano"], ["Piano", "Synth"], ["Synth"]]);
  });

  it("detaches disconnected inputs that stay in the list", async () => {
    const { access, adapter } = setup();
    await adapter.start();
    const input = access.map.get("a");
    if (!input) throw new Error("no input");
    input.state = "disconnected";
    access.dispatchEvent(new Event("statechange"));
    expect(input.listenerCount).toBe(0);
    expect(adapter.listInputs()).toEqual([]);
  });

  it("stop() detaches every listener and silences the adapter", async () => {
    const { access, adapter, notes } = setup({ inputs: [new FakeInput("a"), new FakeInput("b")] });
    await adapter.start();
    adapter.stop();
    for (const i of access.map.values()) expect(i.listenerCount).toBe(0);
    expect(access.statechangeListeners).toBe(0);
    access.map.get("a")?.send([0x90, 60, 80]);
    expect(notes).toEqual([]);
  });

  it("reports unavailable instead of throwing when Web MIDI is missing", async () => {
    const adapter = new MidiAdapter({ requestMIDIAccess: undefined, getContext: () => undefined });
    await expect(adapter.start()).resolves.toBeUndefined();
    expect(adapter.available).toBe(false);
    expect(adapter.status).toBe("unsupported");
    adapter.stop();
  });

  it("reports unavailable when access is refused", async () => {
    const adapter = new MidiAdapter({
      requestMIDIAccess: () => Promise.reject(new Error("denied")),
      getContext: () => undefined,
    });
    await adapter.start();
    expect(adapter.available).toBe(false);
    expect(adapter.status).toBe("denied");
  });

  it("falls back to the context clock when there is no output timestamp", async () => {
    const access = new FakeAccess();
    access.map.set("a", new FakeInput("a"));
    const adapter = new MidiAdapter({
      requestMIDIAccess: () => Promise.resolve(access as unknown as MidiAccessLike),
      getContext: () => ({ currentTime: 5 }),
      now: () => 20000,
    });
    const notes: NoteEvent[] = [];
    adapter.onNote((n) => notes.push(n));
    await adapter.start();
    // The key was struck 50 ms ago.
    access.map.get("a")?.send([0x90, 60, 80], 19950);
    expect(notes[0]?.onsetMs).toBe(4950);
  });
});

describe("isMidiSupported", () => {
  it("follows navigator.requestMIDIAccess", () => {
    const nav = globalThis.navigator as unknown as { requestMIDIAccess?: unknown };
    const had = "requestMIDIAccess" in nav;
    delete nav.requestMIDIAccess;
    expect(isMidiSupported()).toBe(false);
    nav.requestMIDIAccess = () => Promise.resolve({});
    expect(isMidiSupported()).toBe(true);
    if (!had) delete nav.requestMIDIAccess;
  });
});
