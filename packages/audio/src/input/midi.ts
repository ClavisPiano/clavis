import type { NoteEvent, PitchFrame } from "@clavis/core";
import { Emitter, type InputAdapter } from "./types.js";
import { eventTimeToContextMs, type OutputTimestampLike } from "./time.js";

/*
 * Web MIDI input (architecture 4.1, learning spec 11). Chromium, Android and desktop only: Safari
 * has no Web MIDI, so on iOS the adapter reports unavailable and never throws.
 *
 * The adapter structurally types the slice of the Web MIDI API it uses, so it needs no DOM typings
 * and tests can pass an EventTarget-based fake.
 *
 * Sustain pedal (CC 64) and every other controller message are ignored for now: a note's offset is
 * the key release, not the pedal release.
 */

export interface MidiMessageEventLike {
  /** `performance.now()` clock in ms, the same clock as DOM `event.timeStamp`. */
  readonly timeStamp?: number;
  readonly data: Uint8Array | null;
}

export interface MidiInputLike {
  readonly id: string;
  readonly name?: string | null;
  readonly manufacturer?: string | null;
  readonly type?: string;
  readonly state?: string;
  addEventListener(type: "midimessage", listener: (e: MidiMessageEventLike) => void): void;
  removeEventListener(type: "midimessage", listener: (e: MidiMessageEventLike) => void): void;
}

export interface MidiAccessLike {
  readonly inputs: { forEach(cb: (input: MidiInputLike) => void): void };
  addEventListener(type: "statechange", listener: (e: unknown) => void): void;
  removeEventListener(type: "statechange", listener: (e: unknown) => void): void;
}

export type RequestMidiAccess = (options?: { sysex?: boolean }) => Promise<MidiAccessLike>;

/** The slice of `AudioContext` the adapter needs (same as the tap adapter). */
export interface MidiContextLike {
  readonly currentTime: number;
  getOutputTimestamp?(): OutputTimestampLike;
}

export interface MidiDeviceInfo {
  id: string;
  name: string;
}

/** `available`: ready (or not yet started); `unsupported`: no Web MIDI; `denied`: access refused. */
export type MidiStatus = "idle" | "available" | "unsupported" | "denied";

export interface MidiAdapterOptions {
  /** Default: `navigator.requestMIDIAccess` when present. */
  requestMIDIAccess?: RequestMidiAccess | undefined;
  /** Looked up on every event, so a context created after the adapter still works. */
  getContext: () => MidiContextLike | undefined;
  /** `performance.now()`. Injectable for tests. */
  now?: () => number;
  /** 1-16. Messages on other channels are ignored. Default: every channel. */
  channel?: number | undefined;
  /** Listen to this input only. Default (undefined): every input. */
  inputId?: string | undefined;
}

function defaultRequest(): RequestMidiAccess | undefined {
  if (typeof navigator === "undefined") return undefined;
  const nav = navigator as { requestMIDIAccess?: (o?: { sysex?: boolean }) => Promise<unknown> };
  const fn = nav.requestMIDIAccess;
  return typeof fn === "function"
    ? (o) => fn.call(navigator, o) as Promise<MidiAccessLike>
    : undefined;
}

/** Whether this browser has Web MIDI at all (false on iOS Safari). */
export function isMidiSupported(): boolean {
  return defaultRequest() !== undefined;
}

export class MidiAdapter implements InputAdapter {
  readonly source = "midi" as const;
  readonly #notes = new Emitter<NoteEvent>();
  readonly #frames = new Emitter<PitchFrame>();
  readonly #releases = new Emitter<{ pitch: number; offsetMs: number }>();
  readonly #devices = new Emitter<MidiDeviceInfo[]>();
  readonly #request: RequestMidiAccess | undefined;
  readonly #getContext: () => MidiContextLike | undefined;
  readonly #now: () => number;
  readonly #attached = new Map<
    string,
    { input: MidiInputLike; listener: (e: MidiMessageEventLike) => void }
  >();
  #channel: number | undefined;
  #inputId: string | undefined;
  #access: MidiAccessLike | undefined;
  #status: MidiStatus = "idle";
  #running = false;
  #paused = false;
  /** Bumped by `stop()`, so a `start()` still waiting on the permission prompt gives up. */
  #generation = 0;
  /** Notes sounding, per input id, so a note off only reports a release for a held note. */
  readonly #held = new Map<string, Set<number>>();

  constructor(options: MidiAdapterOptions) {
    this.#request = "requestMIDIAccess" in options ? options.requestMIDIAccess : defaultRequest();
    this.#getContext = options.getContext;
    this.#now = options.now ?? (() => performance.now());
    this.#channel = options.channel;
    this.#inputId = options.inputId;
  }

  get status(): MidiStatus {
    return this.#status;
  }

  /** False when Web MIDI is missing or access was refused. True before `start` when supported. */
  get available(): boolean {
    return this.#status === "idle" || this.#status === "available";
  }

  /** Inputs currently connected (empty until started). */
  listInputs(): MidiDeviceInfo[] {
    const out: MidiDeviceInfo[] = [];
    this.#access?.inputs.forEach((i) => {
      if (i.state === undefined || i.state === "connected") {
        out.push({ id: i.id, name: i.name ?? i.id });
      }
    });
    return out;
  }

  /** Listen to one input by id, or every input with `undefined`. Takes effect immediately. */
  setInput(id: string | undefined): void {
    this.#inputId = id;
    this.#sync();
  }

  setChannel(channel: number | undefined): void {
    this.#channel = channel;
  }

  async start(): Promise<void> {
    if (this.#running) return;
    if (!this.#request) {
      this.#status = "unsupported";
      return;
    }
    const generation = this.#generation;
    let access: MidiAccessLike;
    try {
      access = await this.#request({ sysex: false });
    } catch {
      if (generation === this.#generation) this.#status = "denied";
      return;
    }
    if (generation !== this.#generation) return;
    this.#running = true;
    this.#status = "available";
    this.#access = access;
    access.addEventListener("statechange", this.#onStateChange);
    this.#sync();
  }

  stop(): void {
    this.#generation++;
    this.#running = false;
    this.#access?.removeEventListener("statechange", this.#onStateChange);
    this.#access = undefined;
    for (const { input, listener } of this.#attached.values()) {
      input.removeEventListener("midimessage", listener);
    }
    this.#attached.clear();
    this.#held.clear();
    if (this.#status === "available") this.#status = "idle";
  }

  pause(): void {
    this.#paused = true;
  }

  resume(): void {
    this.#paused = false;
  }

  setExpectedRange(): void {
    // Keys are exact, so there is no octave to resolve.
  }

  onNote(cb: (e: NoteEvent) => void): () => void {
    return this.#notes.add(cb);
  }

  /** MIDI has no pitch frames; the subscription is accepted and never fires. */
  onFrame(cb: (f: PitchFrame) => void): () => void {
    return this.#frames.add(cb);
  }

  /** Called with the connected inputs after start and whenever one is plugged or unplugged. */
  onDevicesChanged(cb: (devices: MidiDeviceInfo[]) => void): () => void {
    return this.#devices.add(cb);
  }

  /** Key releases (note off, or note on with velocity 0), on the AudioContext clock. */
  onRelease(cb: (e: { pitch: number; offsetMs: number }) => void): () => void {
    return this.#releases.add(cb);
  }

  readonly #onStateChange = (): void => {
    this.#sync();
  };

  /** Attach to the wanted inputs and detach from the rest. */
  #sync(): void {
    const access = this.#access;
    if (!access || !this.#running) return;
    const wanted = new Map<string, MidiInputLike>();
    access.inputs.forEach((input) => {
      if (input.type !== undefined && input.type !== "input") return;
      if (input.state !== undefined && input.state !== "connected") return;
      if (this.#inputId !== undefined && input.id !== this.#inputId) return;
      wanted.set(input.id, input);
    });
    for (const [id, entry] of [...this.#attached]) {
      if (wanted.get(id) !== entry.input) {
        entry.input.removeEventListener("midimessage", entry.listener);
        this.#attached.delete(id);
        this.#held.delete(id);
      }
    }
    for (const [id, input] of wanted) {
      if (this.#attached.has(id)) continue;
      const listener = (e: MidiMessageEventLike): void => {
        this.#onMessage(id, e);
      };
      input.addEventListener("midimessage", listener);
      this.#attached.set(id, { input, listener });
    }
    this.#devices.emit(this.listInputs());
  }

  #onMessage(inputId: string, e: MidiMessageEventLike): void {
    const data = e.data;
    if (!this.#running || !data || data.length < 3) return;
    const status = data[0] ?? 0;
    const kind = status & 0xf0;
    if (kind !== 0x90 && kind !== 0x80) return;
    if (this.#channel !== undefined && (status & 0x0f) + 1 !== this.#channel) return;
    const pitch = (data[1] ?? 0) & 0x7f;
    const velocity = (data[2] ?? 0) & 0x7f;
    const atMs = this.#toContextMs(e.timeStamp ?? this.#now());
    const isOn = kind === 0x90 && velocity > 0;
    if (!isOn) {
      const held = this.#held.get(inputId);
      if (held?.delete(pitch)) this.#releases.emit({ pitch, offsetMs: atMs });
      return;
    }
    // While paused (stimulus playing) the note is dropped, like every other adapter.
    if (this.#paused) return;
    let held = this.#held.get(inputId);
    if (!held) {
      held = new Set();
      this.#held.set(inputId, held);
    }
    held.add(pitch);
    this.#notes.emit({ pitch, onsetMs: atMs, velocity, confidence: 1, source: "midi" });
  }

  #toContextMs(eventTimeStamp: number): number {
    const ctx = this.#getContext();
    return eventTimeToContextMs(eventTimeStamp, {
      outputTimestamp: ctx?.getOutputTimestamp?.(),
      contextNowMs: (ctx?.currentTime ?? 0) * 1000,
      performanceNowMs: this.#now(),
    });
  }
}
