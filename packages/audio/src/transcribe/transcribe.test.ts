import type { NoteEvent } from "@clavis/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MicInputAdapter, type MicSourceLike } from "../input/mic-adapter";
import type { CaptureChunk, MicTake, WorkerOutbound } from "../mic/messages";
import { PitchWorkerCore } from "../mic/worker-core";
import { toNoteEvents } from "./notes";
import { resampleMono } from "./resample";
import type { Transcriber, TranscribedNote } from "./types";

function sine(freq: number, rate: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.floor(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

function rms(x: Float32Array, from = 0.1, to = 0.9): number {
  const a = Math.floor(x.length * from);
  const b = Math.floor(x.length * to);
  let sum = 0;
  for (let i = a; i < b; i++) sum += (x[i] ?? 0) ** 2;
  return Math.sqrt(sum / (b - a));
}

describe("resampleMono", () => {
  it("returns a copy at the same rate", () => {
    const x = Float32Array.from([1, 2, 3]);
    const y = resampleMono(x, 48000, 48000);
    expect(Array.from(y)).toEqual([1, 2, 3]);
    expect(y).not.toBe(x);
  });

  it.each([
    [48000, 22050],
    [44100, 22050],
    [22050, 44100],
  ])("keeps a 440 Hz tone at %i -> %i Hz", (from, to) => {
    const y = resampleMono(sine(440, from, 1), from, to);
    expect(Math.abs(y.length - to)).toBeLessThanOrEqual(1);
    expect(rms(y)).toBeGreaterThan(0.68);
    expect(rms(y)).toBeLessThan(0.74);
  });

  it("removes a tone above the new Nyquist instead of aliasing it", () => {
    // 15 kHz at 48 kHz would fold to 7.05 kHz at 22.05 kHz if it were not filtered out.
    const y = resampleMono(sine(15000, 48000, 1), 48000, 22050);
    expect(rms(y)).toBeLessThan(0.05);
  });

  it("gives an output length of the duration times the new rate", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4000 }), (n) => {
        const y = resampleMono(new Float32Array(n), 48000, 22050);
        expect(y.length).toBe(Math.floor(n / (48000 / 22050)));
      }),
    );
  });

  it("handles empty input", () => {
    expect(resampleMono(new Float32Array(0), 48000, 22050).length).toBe(0);
  });
});

describe("toNoteEvents", () => {
  const note = (over: Partial<TranscribedNote>): TranscribedNote => ({
    startSec: 0,
    durationSec: 0.5,
    midi: 60,
    amplitude: 0.8,
    ...over,
  });

  it("puts notes on the AudioContext clock, sorted, with velocity and confidence", () => {
    const events = toNoteEvents(
      [note({ startSec: 1, midi: 67 }), note({ startSec: 0.5, midi: 64, amplitude: 0.5 })],
      { startMs: 10_000 },
    );
    expect(events).toEqual([
      {
        pitch: 64,
        onsetMs: 10_500,
        offsetMs: 11_000,
        velocity: 64,
        confidence: 0.5,
        source: "mic",
      },
      {
        pitch: 67,
        onsetMs: 11_000,
        offsetMs: 11_500,
        velocity: 102,
        confidence: 0.8,
        source: "mic",
      },
    ]);
  });

  it("orders simultaneous notes by pitch", () => {
    const events = toNoteEvents([note({ midi: 67 }), note({ midi: 60 }), note({ midi: 64 })], {
      startMs: 0,
    });
    expect(events.map((e) => e.pitch)).toEqual([60, 64, 67]);
  });

  it("drops weak notes and notes outside the MIDI range", () => {
    const events = toNoteEvents(
      [note({ amplitude: 0.1 }), note({ midi: 130 }), note({ midi: -1 }), note({ midi: 61 })],
      { startMs: 0 },
    );
    expect(events.map((e) => e.pitch)).toEqual([61]);
  });

  it("honours a custom threshold", () => {
    expect(
      toNoteEvents([note({ amplitude: 0.1 })], { startMs: 0, minAmplitude: 0.05 }),
    ).toHaveLength(1);
  });

  it("produces valid events for any transcription", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            startSec: fc.double({ min: 0, max: 30, noNaN: true }),
            durationSec: fc.double({ min: 0, max: 5, noNaN: true }),
            midi: fc.integer({ min: 0, max: 127 }),
            amplitude: fc.double({ min: 0, max: 2, noNaN: true }),
          }),
        ),
        (notes) => {
          const events = toNoteEvents(notes, { startMs: 5000 });
          for (const e of events) {
            expect(e.confidence).toBeLessThanOrEqual(1);
            expect(e.velocity).toBeLessThanOrEqual(127);
            expect(e.offsetMs).toBeGreaterThanOrEqual(e.onsetMs);
          }
          const onsets = events.map((e) => e.onsetMs);
          expect(onsets).toEqual([...onsets].sort((a, b) => a - b));
        },
      ),
    );
  });
});

describe("PitchWorkerCore takes", () => {
  const SR = 48000;
  const chunk = (value: number, startFrame: number, n = 2048): CaptureChunk => ({
    type: "chunk",
    samples: new Float32Array(n).fill(value),
    startFrame,
    sampleRate: SR,
  });

  it("records what was heard since the last resume, on the AudioContext clock", () => {
    const core = new PitchWorkerCore(() => undefined);
    core.pause();
    core.handleChunk(chunk(0.5, 0)); // dropped: paused
    core.resume();
    core.handleChunk(chunk(0.1, SR));
    core.handleChunk(chunk(0.2, SR + 2048));
    const take = core.takeSnapshot();
    expect(take.sampleRate).toBe(SR);
    expect(take.startMs).toBeCloseTo(1000, 3);
    expect(take.samples.length).toBe(4096);
    expect(take.samples[0]).toBeCloseTo(0.1);
    expect(take.samples[4095]).toBeCloseTo(0.2);
    expect(take.truncated).toBe(false);
  });

  it("starts a fresh take on resume and discards the take on pause", () => {
    const core = new PitchWorkerCore(() => undefined);
    core.resume();
    core.handleChunk(chunk(0.1, 0));
    core.resume();
    expect(core.takeSnapshot().samples.length).toBe(0);
    core.handleChunk(chunk(0.1, 4096));
    core.pause();
    expect(core.takeSnapshot().samples.length).toBe(0);
  });

  it("stops recording at the length cap and says so", () => {
    const out: WorkerOutbound[] = [];
    const core = new PitchWorkerCore((m) => out.push(m));
    core.resume();
    const perChunk = SR; // one second
    for (let i = 0; i < 40; i++) core.handleChunk(chunk(0.1, i * perChunk, perChunk));
    const take = core.takeSnapshot();
    expect(take.samples.length).toBe(30 * SR);
    expect(take.truncated).toBe(true);
  });
});

describe("MicInputAdapter.finishTake", () => {
  const take: MicTake = {
    samples: new Float32Array(48000),
    sampleRate: 48000,
    startMs: 2000,
    truncated: false,
  };
  const source = (t: MicTake | undefined): MicSourceLike => ({
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    pause: () => undefined,
    resume: () => undefined,
    onNote: () => () => undefined,
    onFrame: () => () => undefined,
    ...(t ? { takeAudio: () => Promise.resolve(t) } : {}),
  });
  const ctx = () => ({}) as never;

  it("does not transcribe without a transcriber", async () => {
    const mic = new MicInputAdapter({ source: source(take), getContext: ctx });
    expect(mic.transcribes).toBe(false);
    expect(await mic.finishTake()).toEqual([]);
  });

  it("transcribes the take into note events on the context clock", async () => {
    let heard: [number, number] | undefined;
    const transcriber: Transcriber = {
      transcribe: (samples, rate) => {
        heard = [samples.length, rate];
        return Promise.resolve([
          { startSec: 0.5, durationSec: 0.4, midi: 48, amplitude: 0.9 },
          { startSec: 0.5, durationSec: 0.4, midi: 52, amplitude: 0.9 },
        ]);
      },
    };
    const mic = new MicInputAdapter({ source: source(take), getContext: ctx, transcriber });
    expect(mic.transcribes).toBe(true);
    const notes: NoteEvent[] = await mic.finishTake();
    expect(heard).toEqual([48000, 48000]);
    expect(notes.map((n) => [n.pitch, n.onsetMs])).toEqual([
      [48, 2500],
      [52, 2500],
    ]);
  });

  it("returns nothing when the transcriber fails or the take is empty", async () => {
    const failing: Transcriber = { transcribe: () => Promise.reject(new Error("model failed")) };
    const a = new MicInputAdapter({ source: source(take), getContext: ctx, transcriber: failing });
    expect(await a.finishTake()).toEqual([]);
    const empty: MicTake = { ...take, samples: new Float32Array(0) };
    const ok: Transcriber = { transcribe: () => Promise.resolve([]) };
    const b = new MicInputAdapter({ source: source(empty), getContext: ctx, transcriber: ok });
    expect(await b.finishTake()).toEqual([]);
  });

  it("is not a transcribing input when the source cannot record", () => {
    const ok: Transcriber = { transcribe: () => Promise.resolve([]) };
    const mic = new MicInputAdapter({
      source: source(undefined),
      getContext: ctx,
      transcriber: ok,
    });
    expect(mic.transcribes).toBe(false);
  });
});
