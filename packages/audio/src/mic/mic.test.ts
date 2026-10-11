import type { NoteEvent, PitchFrame } from "@clavis/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderNotes } from "../pitch/synth";
import {
  CAPTURE_PROCESSOR_NAME,
  type CaptureChunk,
  type WorkerInbound,
  type WorkerOutbound,
} from "./messages";
import { MicPitchSource, type CaptureContext, type WorkerLike } from "./mic-source";
import { PitchWorkerCore } from "./worker-core";

const SR = 48000;

function chunksOf(x: Float32Array, size: number, startFrame = 0): CaptureChunk[] {
  const out: CaptureChunk[] = [];
  for (let i = 0; i < x.length; i += size) {
    out.push({
      type: "chunk",
      samples: x.slice(i, i + size),
      startFrame: startFrame + i,
      sampleRate: SR,
    });
  }
  return out;
}

describe("PitchWorkerCore", () => {
  const x = renderNotes(
    [
      { midi: 60, startSec: 0.2, durSec: 0.4, timbre: "piano" },
      { midi: 67, startSec: 1.0, durSec: 0.4, timbre: "piano" },
    ],
    SR,
    1.8,
  );

  it("posts frames and notes on the AudioContext clock", () => {
    const out: WorkerOutbound[] = [];
    const core = new PitchWorkerCore((m) => out.push(m));
    const startFrame = SR * 10; // context has been running for 10 s
    for (const c of chunksOf(x, 2048, startFrame)) core.handleChunk(c);
    core.stop();
    const notes = out.flatMap((m) => (m.type === "note" ? [m] : []));
    expect(notes.map((m) => `${m.phase}:${String(m.note.pitch)}`)).toEqual([
      "start:60",
      "end:60",
      "start:67",
      "end:67",
    ]);
    expect(Math.abs((notes[0]?.note.onsetMs ?? 0) - 10_200)).toBeLessThan(30);
    expect(Math.abs((notes[2]?.note.onsetMs ?? 0) - 11_000)).toBeLessThan(30);
    expect(out.filter((m) => m.type === "frame").length).toBeGreaterThan(100);
    expect(out.at(-1)).toEqual({ type: "stopped" });
  });

  it("drops audio while paused and discards the note in progress", () => {
    const out: WorkerOutbound[] = [];
    const core = new PitchWorkerCore((m) => out.push(m));
    const all = chunksOf(x, 2048);
    const mid = all.findIndex((c) => c.startFrame / SR > 1.1);
    for (const c of all.slice(0, mid)) core.handleChunk(c);
    out.length = 0;
    core.pause();
    for (const c of all.slice(mid, mid + 10)) core.handleChunk(c);
    expect(out).toEqual([]);
    core.resume();
    for (const c of all.slice(mid + 10)) core.handleChunk(c);
    core.stop();
    expect(out.some((m) => m.type === "note" && m.phase === "end")).toBe(false);
  });
});

describe("capture worklet", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers under the shared name and posts transferred 2048-sample chunks", async () => {
    const registered: { name?: string; ctor?: new (o?: unknown) => unknown } = {};
    const g = { currentFrame: 0 };
    vi.stubGlobal(
      "AudioWorkletProcessor",
      class {
        port: { onmessage: ((e: { data: unknown }) => void) | null } = { onmessage: null };
      },
    );
    vi.stubGlobal("registerProcessor", (name: string, ctor: new (o?: unknown) => unknown) => {
      registered.name = name;
      registered.ctor = ctor;
    });
    vi.stubGlobal("sampleRate", SR);
    vi.stubGlobal("currentFrame", 0);
    await import("./capture.worklet");
    expect(registered.name).toBe(CAPTURE_PROCESSOR_NAME);

    if (!registered.ctor) throw new Error("processor not registered");
    const proc = new registered.ctor({
      processorOptions: { chunkSize: 2048 },
    }) as {
      port: { onmessage: ((e: { data: unknown }) => void) | null };
      process(inputs: Float32Array[][]): boolean;
    };
    const posted: { msg: CaptureChunk; transfer: unknown[] }[] = [];
    proc.port.onmessage?.({
      data: {
        type: "port",
        port: {
          postMessage: (msg: CaptureChunk, transfer: unknown[]) => posted.push({ msg, transfer }),
        },
      },
    });
    const quantum = new Float32Array(128).fill(0.25);
    for (let q = 0; q < 33; q++) {
      g.currentFrame = 1000 + q * 128;
      vi.stubGlobal("currentFrame", g.currentFrame);
      expect(proc.process([[quantum]])).toBe(true);
    }
    expect(posted).toHaveLength(2);
    expect(posted[0]?.msg.startFrame).toBe(1000);
    expect(posted[1]?.msg.startFrame).toBe(1000 + 2048);
    expect(posted[0]?.msg.samples).toHaveLength(2048);
    expect(posted[0]?.msg.sampleRate).toBe(SR);
    expect(posted[0]?.transfer).toEqual([posted[0]?.msg.samples.buffer]);
    // No input connected: keeps running without posting.
    expect(proc.process([[]])).toBe(true);
    expect(posted).toHaveLength(2);
  });
});

class FakeWorker implements WorkerLike {
  sent: WorkerInbound[] = [];
  terminated = false;
  #listener: ((e: MessageEvent<WorkerOutbound>) => void) | undefined;
  postMessage(message: WorkerInbound): void {
    this.sent.push(message);
    if (message.type === "stop") this.emit({ type: "stopped" });
  }
  addEventListener(_type: "message", l: (e: MessageEvent<WorkerOutbound>) => void): void {
    this.#listener = l;
  }
  terminate(): void {
    this.terminated = true;
  }
  emit(m: WorkerOutbound): void {
    this.#listener?.({ data: m } as MessageEvent<WorkerOutbound>);
  }
}

function fakeContext() {
  const calls: string[] = [];
  const node = (name: string) => ({
    connect: (to: unknown) => calls.push(`${name}->${(to as { n?: string }).n ?? "dest"}`),
    disconnect: () => calls.push(`${name} disconnect`),
    n: name,
  });
  const ctx = {
    currentTime: 0,
    destination: { n: "destination" },
    audioWorklet: { addModule: vi.fn(() => Promise.resolve()) },
    createMediaStreamSource: () => node("source"),
    createGain: () => ({ ...node("mute"), gain: { value: 1 } }),
  };
  return { ctx: ctx as unknown as CaptureContext, calls, addModule: ctx.audioWorklet.addModule };
}

describe("MicPitchSource", () => {
  function setup() {
    const worker = new FakeWorker();
    const stopTrack = vi.fn();
    const getUserMedia = vi.fn(() =>
      Promise.resolve({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream),
    );
    const posted: unknown[] = [];
    const mic = new MicPitchSource({
      assets: { workletUrl: "/worklet.js", createWorker: () => worker },
      deps: {
        getUserMedia,
        createWorkletNode: () =>
          ({
            port: { postMessage: (m: unknown) => posted.push(m) },
            connect: () => undefined,
            disconnect: () => undefined,
          }) as unknown as AudioWorkletNode,
        createChannel: () => ({ port1: {}, port2: {} }) as unknown as MessageChannel,
      },
    });
    return { mic, worker, getUserMedia, stopTrack, posted };
  }

  const frame: PitchFrame = { hz: 440, cents: 0, confidence: 0.99, atMs: 1234 };
  const note: NoteEvent = { pitch: 69, onsetMs: 1200, confidence: 0.9, source: "mic" };

  it("requests an unprocessed mono stream, wires the graph and hands the port to the worker", async () => {
    const { mic, worker, getUserMedia, posted } = setup();
    const { ctx, calls, addModule } = fakeContext();
    await mic.start({ context: ctx, constraints: { noiseSuppression: true } });
    expect(mic.state).toBe("running");
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    expect(addModule).toHaveBeenCalledWith("/worklet.js");
    expect(worker.sent[0]?.type).toBe("init");
    expect(posted[0]).toMatchObject({ type: "port" });
    expect(calls).toContain("mute->destination");
    // A second start is a no-op.
    await mic.start({ context: ctx });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("delivers frames and notes, and drops them while paused", async () => {
    const { mic, worker } = setup();
    const { ctx } = fakeContext();
    const frames: PitchFrame[] = [];
    const notes: string[] = [];
    mic.onFrame((f) => frames.push(f));
    const off = mic.onNote((n, phase) => notes.push(`${phase}:${String(n.pitch)}`));
    await mic.start({ context: ctx });
    worker.emit({ type: "frame", frame });
    worker.emit({ type: "note", phase: "start", note });
    mic.pause();
    expect(worker.sent.at(-1)).toEqual({ type: "pause" });
    worker.emit({ type: "frame", frame });
    worker.emit({ type: "note", phase: "end", note });
    mic.resume();
    expect(worker.sent.at(-1)).toEqual({ type: "resume" });
    worker.emit({ type: "note", phase: "end", note });
    off();
    worker.emit({ type: "note", phase: "end", note });
    expect(frames).toHaveLength(1);
    expect(notes).toEqual(["start:69", "end:69"]);
  });

  it("stop releases the stream and the worker", async () => {
    const { mic, worker, stopTrack } = setup();
    const { ctx } = fakeContext();
    await mic.start({ context: ctx });
    await mic.stop();
    expect(worker.sent.at(-1)).toEqual({ type: "stop" });
    expect(worker.terminated).toBe(true);
    expect(stopTrack).toHaveBeenCalled();
    expect(mic.state).toBe("idle");
  });

  it("goes back to idle and releases the stream if setup fails", async () => {
    const { mic, stopTrack } = setup();
    const { ctx, addModule } = fakeContext();
    addModule.mockRejectedValueOnce(new Error("no worklet"));
    await expect(mic.start({ context: ctx })).rejects.toThrow("no worklet");
    expect(mic.state).toBe("idle");
    expect(stopTrack).toHaveBeenCalled();
  });
});
